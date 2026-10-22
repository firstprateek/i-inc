import "./components/app.ts";
import { captureInstallPrompt } from "./install.ts";
import { keepNotificationsTidy } from "./notifications.ts";
import { followNotificationTaps, registerServiceWorker } from "./register-sw.ts";

registerServiceWorker();
captureInstallPrompt();
followNotificationTaps();
keepNotificationsTidy();
