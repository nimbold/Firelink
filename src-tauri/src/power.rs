use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

const ASSERTION_REASON: &str = "Firelink active download";

/// Owns the OS power assertions for the whole backend transfer lifecycle.
///
/// The frontend may request the policy, but it does not own the assertion:
/// queue permits are the source of truth for whether a transfer is actually
/// active. Keeping the two assertions separate also means display sleep can
/// be opted into without changing the system-sleep policy.
struct PowerState {
    runtime_enabled: AtomicBool,
    prevent_system_sleep: AtomicBool,
    prevent_display_sleep: AtomicBool,
    active_transfers: AtomicUsize,
}

enum PowerCommand {
    Reconcile(Option<Sender<Result<(), String>>>),
}

struct PowerWorker {
    sender: Option<Sender<PowerCommand>>,
    join_handle: Option<JoinHandle<()>>,
}

impl PowerWorker {
    fn start(state: Arc<PowerState>) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let join_handle = thread::Builder::new()
            .name("firelink-power".to_string())
            .spawn(move || run_power_worker(state, receiver))
            .map_err(|error| format!("failed to start power-management worker: {error}"))?;
        Ok(Self {
            sender: Some(sender),
            join_handle: Some(join_handle),
        })
    }

    fn send(&self, command: PowerCommand) -> Result<(), String> {
        self.sender
            .as_ref()
            .ok_or_else(|| "power-management worker is stopping".to_string())?
            .send(command)
            .map_err(|_| "power-management worker stopped unexpectedly".to_string())
    }
}

impl Drop for PowerWorker {
    fn drop(&mut self) {
        // Closing the sender lets the worker drop its OS assertions on the
        // same thread that created them. This matters on Windows, where
        // SetThreadExecutionState is thread-local, and avoids calling the
        // Linux keepawake D-Bus destructor from an arbitrary queue thread.
        self.sender.take();
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
    }
}

pub struct PowerManager {
    state: Arc<PowerState>,
    worker: Mutex<Option<PowerWorker>>,
}

impl PowerManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Arc::new(PowerState {
                runtime_enabled: AtomicBool::new(false),
                prevent_system_sleep: AtomicBool::new(true),
                prevent_display_sleep: AtomicBool::new(false),
                active_transfers: AtomicUsize::new(0),
            }),
            worker: Mutex::new(None),
        })
    }

    /// Enables OS integration after AppState has been registered. This keeps
    /// QueueManager tests and pre-window startup work from creating real
    /// assertions in the test process or during partial initialization.
    pub fn activate(&self) -> Result<(), String> {
        self.state.runtime_enabled.store(true, Ordering::Release);
        self.reconcile()
    }

    pub fn set_preferences(
        &self,
        prevent_system_sleep: bool,
        prevent_display_sleep: bool,
    ) -> Result<(), String> {
        self.state
            .prevent_system_sleep
            .store(prevent_system_sleep, Ordering::Release);
        self.state
            .prevent_display_sleep
            .store(prevent_display_sleep, Ordering::Release);
        self.reconcile()
    }

    pub fn set_system_prevention(&self, enabled: bool) -> Result<(), String> {
        self.state
            .prevent_system_sleep
            .store(enabled, Ordering::Release);
        self.reconcile()
    }

    pub fn set_display_prevention(&self, enabled: bool) -> Result<(), String> {
        self.state
            .prevent_display_sleep
            .store(enabled, Ordering::Release);
        self.reconcile()
    }

    pub fn set_active_transfer_count(self: &Arc<Self>, count: usize) {
        self.state.active_transfers.store(count, Ordering::Release);
        if self.state.runtime_enabled.load(Ordering::Acquire) {
            if let Err(error) = self.enqueue_reconcile() {
                log::error!(
                    "power: failed to schedule assertion reconciliation for {count} active transfer(s): {error}"
                );
            }
        }
    }

    pub fn active_transfer_count(&self) -> usize {
        self.state.active_transfers.load(Ordering::Acquire)
    }

    fn reconcile(&self) -> Result<(), String> {
        if !self.state.runtime_enabled.load(Ordering::Acquire) {
            return Ok(());
        }

        self.ensure_worker()?;
        let (response_sender, response_receiver) = mpsc::channel();
        if let Err(error) = self.send_command(PowerCommand::Reconcile(Some(response_sender))) {
            self.restart_worker();
            return Err(error);
        }
        match response_receiver.recv() {
            Ok(result) => result,
            Err(_) => {
                self.restart_worker();
                Err("power-management worker stopped before reporting reconciliation".to_string())
            }
        }
    }

    fn enqueue_reconcile(&self) -> Result<(), String> {
        self.ensure_worker()?;
        if let Err(error) = self.send_command(PowerCommand::Reconcile(None)) {
            self.restart_worker();
            return Err(error);
        }
        Ok(())
    }

    fn ensure_worker(&self) -> Result<(), String> {
        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if worker.is_none() {
            *worker = Some(PowerWorker::start(Arc::clone(&self.state))?);
        }
        Ok(())
    }

    fn send_command(&self, command: PowerCommand) -> Result<(), String> {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        worker
            .as_ref()
            .ok_or_else(|| "power-management worker is not running".to_string())?
            .send(command)
    }

    fn restart_worker(&self) {
        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        worker.take();
    }
}

struct OsPowerAssertions {
    #[cfg(windows)]
    assertion: Option<keepawake::KeepAwake>,
    #[cfg(not(windows))]
    system: Option<keepawake::KeepAwake>,
    #[cfg(not(windows))]
    display: Option<keepawake::KeepAwake>,
    system_enabled: bool,
    display_enabled: bool,
}

impl OsPowerAssertions {
    fn reconcile(&mut self, state: &PowerState) -> Result<(), String> {
        let active = state.active_transfers.load(Ordering::Acquire);
        let desired_system = active > 0 && state.prevent_system_sleep.load(Ordering::Acquire);
        let desired_display = active > 0 && state.prevent_display_sleep.load(Ordering::Acquire);

        #[cfg(windows)]
        {
            return self.reconcile_combined(desired_system, desired_display, active);
        }
        #[cfg(not(windows))]
        self.reconcile_independent(desired_system, desired_display, active)
    }

    #[cfg(windows)]
    fn reconcile_combined(
        &mut self,
        desired_system: bool,
        desired_display: bool,
        active: usize,
    ) -> Result<(), String> {
        if self.system_enabled == desired_system && self.display_enabled == desired_display {
            return Ok(());
        }

        if let Some(assertion) = self.assertion.take() {
            drop_assertion(assertion, "combined");
            if self.system_enabled {
                log::info!("power: system-sleep prevention released");
            }
            if self.display_enabled {
                log::info!("power: display-sleep prevention released");
            }
            self.system_enabled = false;
            self.display_enabled = false;
        }

        if desired_system || desired_display {
            let assertion = create_assertion(|| {
                keepawake::Builder::default()
                    .display(desired_display)
                    .idle(desired_system)
                    .sleep(desired_system)
                    .reason(ASSERTION_REASON)
                    .create()
            })
            .map_err(|error| format!("failed to apply power prevention: {error}"))?;
            self.assertion = Some(assertion);
            self.system_enabled = desired_system;
            self.display_enabled = desired_display;
            if desired_system {
                log::info!(
                    "power: system-sleep prevention enabled for {active} active transfer(s)"
                );
            }
            if desired_display {
                log::info!(
                    "power: display-sleep prevention enabled for {active} active transfer(s)"
                );
            }
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn reconcile_independent(
        &mut self,
        desired_system: bool,
        desired_display: bool,
        active: usize,
    ) -> Result<(), String> {
        let mut first_error = None;
        if desired_system {
            if self.system.is_none() {
                match create_assertion(|| {
                    keepawake::Builder::default()
                        .idle(true)
                        .sleep(true)
                        .reason(ASSERTION_REASON)
                        .create()
                }) {
                    Ok(assertion) => {
                        self.system = Some(assertion);
                        self.system_enabled = true;
                        log::info!(
                            "power: system-sleep prevention enabled for {active} active transfer(s)"
                        );
                    }
                    Err(error) => {
                        first_error = Some(format!("failed to prevent system sleep: {error}"))
                    }
                }
            }
        } else if let Some(assertion) = self.system.take() {
            drop_assertion(assertion, "system-sleep");
            self.system_enabled = false;
            log::info!("power: system-sleep prevention released");
        }

        if desired_display {
            if self.display.is_none() {
                match create_assertion(|| {
                    keepawake::Builder::default()
                        .display(true)
                        .reason(ASSERTION_REASON)
                        .create()
                }) {
                    Ok(assertion) => {
                        self.display = Some(assertion);
                        self.display_enabled = true;
                        log::info!(
                            "power: display-sleep prevention enabled for {active} active transfer(s)"
                        );
                    }
                    Err(error) => {
                        let display_error = format!("failed to prevent display sleep: {error}");
                        if first_error.is_none() {
                            first_error = Some(display_error);
                        } else {
                            log::error!("power: {display_error}");
                        }
                    }
                }
            }
        } else if let Some(assertion) = self.display.take() {
            drop_assertion(assertion, "display-sleep");
            self.display_enabled = false;
            log::info!("power: display-sleep prevention released");
        }

        first_error.map_or(Ok(()), Err)
    }
}

fn create_assertion(
    create: impl FnOnce() -> keepawake::Result<keepawake::KeepAwake>,
) -> Result<keepawake::KeepAwake, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(create))
        .map_err(|_| "keepawake assertion creation panicked".to_string())?
        .map_err(|error| error.to_string())
}

fn drop_assertion(assertion: keepawake::KeepAwake, kind: &str) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(assertion))).is_err() {
        log::error!("power: keepawake {kind} assertion cleanup panicked");
    }
}

fn run_power_worker(state: Arc<PowerState>, receiver: Receiver<PowerCommand>) {
    let mut assertions = OsPowerAssertions {
        #[cfg(windows)]
        assertion: None,
        #[cfg(not(windows))]
        system: None,
        #[cfg(not(windows))]
        display: None,
        system_enabled: false,
        display_enabled: false,
    };
    while let Ok(PowerCommand::Reconcile(response)) = receiver.recv() {
        let result = assertions.reconcile(&state);
        if let Some(response) = response {
            let _ = response.send(result);
        } else if let Err(error) = result {
            let active = state.active_transfers.load(Ordering::Acquire);
            log::error!(
                "power: failed to reconcile assertions for {active} active transfer(s): {error}"
            );
        }
    }
    #[cfg(windows)]
    if let Some(assertion) = assertions.assertion.take() {
        drop_assertion(assertion, "combined");
    }
    #[cfg(not(windows))]
    {
        if let Some(assertion) = assertions.display.take() {
            drop_assertion(assertion, "display-sleep");
        }
        if let Some(assertion) = assertions.system.take() {
            drop_assertion(assertion, "system-sleep");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PowerManager;

    #[test]
    fn tracks_transfer_activity_before_runtime_activation() {
        let manager = PowerManager::new();
        manager.set_active_transfer_count(2);
        assert_eq!(manager.active_transfer_count(), 2);

        manager.set_active_transfer_count(0);
        assert_eq!(manager.active_transfer_count(), 0);
    }

    #[test]
    fn preference_changes_are_safe_before_runtime_activation() {
        let manager = PowerManager::new();
        assert!(manager.set_preferences(false, true).is_ok());
        assert!(manager.set_system_prevention(true).is_ok());
        assert!(manager.set_display_prevention(false).is_ok());
    }

    #[test]
    fn runtime_worker_can_activate_without_active_transfers() {
        let manager = PowerManager::new();
        assert!(manager.activate().is_ok());
        manager.set_active_transfer_count(0);
        assert_eq!(manager.active_transfer_count(), 0);
    }
}
