import { initLogger } from "./utils/logger";

const rootElement = document.getElementById("root");
if (rootElement) {
  rootElement.textContent = "Firelink startup control";
}

requestAnimationFrame(() => {
  void initLogger();
});
