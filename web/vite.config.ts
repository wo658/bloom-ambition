import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import chatApi from "./server/chat";
import translateApi from "./server/translate";

// .env.local의 키는 서버 쪽(chat·translate API)에서만 쓰고 브라우저로는 내보내지 않는다.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  return { plugins: [react(), chatApi(env), translateApi(env)] };
});
