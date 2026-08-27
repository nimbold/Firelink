import { invoke } from "@tauri-apps/api/core";

void invoke<number>("begin_dock_badge_session");

const rootElement = document.getElementById("root");
if (rootElement) {
  rootElement.textContent = "Firelink startup control";
}
