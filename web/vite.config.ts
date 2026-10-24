import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import manualApi from "./server/api";

export default defineConfig({ plugins: [react(), manualApi()] });
