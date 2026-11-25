import "./styles.css";
import { boot } from "./game";
import { showUnsupported } from "./graphics";

boot().catch((err) => {
  console.error("[boot] fatal:", err);
  showUnsupported(`Startup failed: ${String(err)}`);
});
