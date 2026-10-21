import "./components/app.ts";
import { followNotificationTaps, registerServiceWorker } from "./register-sw.ts";

registerServiceWorker();
followNotificationTaps();
