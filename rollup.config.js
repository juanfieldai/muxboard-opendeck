import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const openDeck = process.env.OPDECK === "true";
const pluginDirectory = openDeck ? "com.juanfieldai.muxboard.sdPlugin" : "com.mrshu.muxboard.sdPlugin";
const input = openDeck ? "src/opendeck.ts" : "src/plugin.ts";
const output = openDeck ? "bin/opendeck.cjs" : "bin/plugin.cjs";

export default {
  input,
  output: {
    file: `${pluginDirectory}/${output}`,
    format: "cjs",
    sourcemap: true,
  },
  plugins: [
    typescript({ tsconfig: "./tsconfig.json", outDir: `${pluginDirectory}/bin` }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
  ],
};
