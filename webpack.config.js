const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    popup: './src/popup/Popup.tsx',
    background: './src/background/background.ts',
    offscreen: './src/offscreen/offscreen.ts'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js']
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './public/popup.html',
      filename: 'popup.html',
      chunks: ['popup'],
      minify: false
    }),
    new HtmlWebpackPlugin({
      template: './src/offscreen/offscreen.html',
      filename: 'offscreen.html',
      chunks: ['offscreen'],
      minify: false
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'public/icons', to: 'icons', noErrorOnMissing: true }
      ]
    })
  ],
  devtool: 'source-map',
  performance: {
    hints: false // Chrome extensions load from disk, not network — size warnings don't apply
  },
  optimization: {
    minimize: false
  }
};
