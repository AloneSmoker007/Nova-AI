import app from "./index.js";
import { registerTask16Routes } from "./task16.routes.js";
import { registerBackupRoutes } from "./backup.routes.js";

registerTask16Routes(app);
registerBackupRoutes(app);
