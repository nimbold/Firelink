import { invoke } from "@tauri-apps/api/core";

const rootElement = document.getElementById("root");
if (rootElement) rootElement.textContent = "Firelink startup control";

const documentLoaded = new Promise<void>((resolve) => {
  const releaseAfterNativeLoad = () => window.setTimeout(resolve, 0);
  if (document.readyState === "complete") releaseAfterNativeLoad();
  else window.addEventListener("load", releaseAfterNativeLoad, { once: true });
});

void documentLoaded.then(async () => {
  await invoke<boolean>("is_log_paused");
  if (rootElement) rootElement.textContent = "Firelink post-load log read";
});
