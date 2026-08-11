use crate::ipc::MainWindowSize;

pub const MAIN_WINDOW_DEFAULT_WIDTH: u32 = 1280;
pub const MAIN_WINDOW_DEFAULT_HEIGHT: u32 = 800;
pub const MAIN_WINDOW_MIN_WIDTH: u32 = 960;
pub const MAIN_WINDOW_MIN_HEIGHT: u32 = 640;
pub const MAIN_WINDOW_MAX_WIDTH: u32 = 16_384;
pub const MAIN_WINDOW_MAX_HEIGHT: u32 = 16_384;

pub fn default_main_window_size() -> MainWindowSize {
    MainWindowSize {
        width: MAIN_WINDOW_DEFAULT_WIDTH,
        height: MAIN_WINDOW_DEFAULT_HEIGHT,
    }
}

pub fn normalize_main_window_size(size: Option<&MainWindowSize>) -> Option<MainWindowSize> {
    let size = size?;
    if size.width < MAIN_WINDOW_MIN_WIDTH
        || size.height < MAIN_WINDOW_MIN_HEIGHT
        || size.width > MAIN_WINDOW_MAX_WIDTH
        || size.height > MAIN_WINDOW_MAX_HEIGHT
    {
        return None;
    }
    Some(size.clone())
}

pub fn clamp_main_window_size(
    size: MainWindowSize,
    work_area_width: u32,
    work_area_height: u32,
) -> MainWindowSize {
    let width_limit = work_area_width.max(MAIN_WINDOW_MIN_WIDTH);
    let height_limit = work_area_height.max(MAIN_WINDOW_MIN_HEIGHT);
    MainWindowSize {
        width: size.width.min(width_limit),
        height: size.height.min(height_limit),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_main_window_size, default_main_window_size, normalize_main_window_size,
        MAIN_WINDOW_MIN_HEIGHT, MAIN_WINDOW_MIN_WIDTH,
    };
    use crate::ipc::MainWindowSize;

    #[test]
    fn default_size_matches_the_main_window_configuration() {
        assert_eq!(default_main_window_size().width, 1280);
        assert_eq!(default_main_window_size().height, 800);
    }

    #[test]
    fn rejects_sizes_outside_the_persisted_bounds() {
        assert!(normalize_main_window_size(Some(&MainWindowSize {
            width: MAIN_WINDOW_MIN_WIDTH - 1,
            height: 800,
        }))
        .is_none());
        assert!(normalize_main_window_size(Some(&MainWindowSize {
            width: 1280,
            height: 16_385,
        }))
        .is_none());
    }

    #[test]
    fn caps_a_valid_size_to_the_available_work_area() {
        let clamped = clamp_main_window_size(
            MainWindowSize {
                width: 1600,
                height: 1000,
            },
            1280,
            720,
        );
        assert_eq!(clamped.width, 1280);
        assert_eq!(clamped.height, 720);
    }

    #[test]
    fn keeps_the_minimum_when_the_work_area_is_shorter_than_the_minimum() {
        let clamped = clamp_main_window_size(
            MainWindowSize {
                width: 1280,
                height: 800,
            },
            800,
            500,
        );
        assert_eq!(clamped.width, MAIN_WINDOW_MIN_WIDTH);
        assert_eq!(clamped.height, MAIN_WINDOW_MIN_HEIGHT);
    }
}
