import "./components/app.ts";
import { wireDesktop } from "./desktop.ts";
import { captureInstallPrompt } from "./install.ts";
import { keepNotificationsTidy } from "./notifications.ts";
import { followNotificationTaps, registerServiceWorker } from "./register-sw.ts";

wireDesktop();
registerServiceWorker();
captureInstallPrompt();
followNotificationTaps();
keepNotificationsTidy();
