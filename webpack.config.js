const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => ({
  entry: {
    popup: './src/popup/Popup.tsx',
    background: './src/background/background.ts',
    offscreen: './src/offscreen/offscreen.ts',
    'peak-worklet': './src/offscreen/peakWorklet.ts',
    export: './src/export/export.ts',
    'mp3-worker': './src/export/mp3Worker.ts'
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
      },
      {
        // Bundled fonts (Vintage theme)
        test: /\.woff2?$/,
        type: 'asset/resource',
        generator: { filename: 'fonts/[name][ext]' }
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
    new HtmlWebpackPlugin({
      template: './src/export/export.html',
      filename: 'export.html',
      chunks: ['export'],
      minify: false
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        // Only the PNG icons the manifest uses
        { from: 'public/icons/*.png', to: 'icons/[name][ext]' }
      ]
    })
  ],
  // Source maps only for development builds; the store package ships readable, unminified code
  devtool: argv.mode === 'production' ? false : 'source-map',
  performance: {
    hints: false // Chrome extensions load from disk, not network — size warnings don't apply
  },
  optimization: {
    minimize: false
  }
});
