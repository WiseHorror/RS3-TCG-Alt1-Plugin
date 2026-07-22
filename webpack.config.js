const path = require("path");
const webpack = require("webpack");

// Release builds define debug=false so minification removes manual reward tools.
module.exports = (env = {}) => ({
  context: path.resolve(__dirname, "src"),
  entry: "./app.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "app.bundle.js"
  },
  devtool: false,
  externals: ["sharp", "canvas", "electron/common"],
  plugins: [
    new webpack.DefinePlugin({
      __DEBUG_TOOLS__: JSON.stringify(env.debug !== "false")
    })
  ],
  resolve: {
    extensions: [".wasm", ".ts", ".mjs", ".js"],
    alias: {
      "alt1-source/xpcounter$": path.resolve(__dirname, "node_modules/alt1-source/src/xpcounter/index.ts"),
      "alt1/base$": path.resolve(__dirname, "node_modules/alt1/dist/base/index.js"),
      "alt1/ocr$": path.resolve(__dirname, "node_modules/alt1/dist/ocr/index.js"),
      "alt1/fonts/chatbox/12pt.fontmeta.json$": path.resolve(
        __dirname,
        "node_modules/alt1/src/fonts/chatbox/12pt.fontmeta.json"
      )
    }
  },
  module: {
    rules: [
      { test: /\.ts$/, loader: "ts-loader", options: { transpileOnly: true } },
      { test: /\.data\.png$/, loader: "alt1/imagedata-loader", type: "javascript/auto" },
      { test: /\.fontmeta\.json$/, loader: "alt1/font-loader" }
    ]
  }
});
