import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import chatApi from "./server/chat";

// .env.local의 키는 서버 쪽(chat API)에서만 쓰고 브라우저로는 내보내지 않는다.
export default defineConfig(({ mode }) => ({
  plugins: [react(), chatApi(loadEnv(mode, __dirname, ""))],
}));
