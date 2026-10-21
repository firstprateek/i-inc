import "./components/app.ts";
import { keepNotificationsTidy } from "./notifications.ts";
import { followNotificationTaps, registerServiceWorker } from "./register-sw.ts";

registerServiceWorker();
followNotificationTaps();
keepNotificationsTidy();
