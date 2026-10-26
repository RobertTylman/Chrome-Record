// Bundles the in-browser pipeline harness for tests/pipeline.spec.ts
const path = require('path');

module.exports = {
  mode: 'development',
  devtool: false,
  entry: { harness: path.resolve(__dirname, 'pipeline/harness.ts') },
  output: { path: path.resolve(__dirname, '.build'), filename: '[name].js', clean: true },
  module: {
    rules: [{
      test: /\.tsx?$/,
      loader: 'ts-loader',
      options: { transpileOnly: true, configFile: path.resolve(__dirname, '../tsconfig.json') }
    }]
  },
  resolve: { extensions: ['.ts', '.js'] }
};
