import { initLogger } from "./utils/logger";

void initLogger();

const rootElement = document.getElementById("root");
if (rootElement) {
  rootElement.textContent = "Firelink startup control";
}
