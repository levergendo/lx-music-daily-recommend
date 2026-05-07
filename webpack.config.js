const path = require('path');
module.exports = {
  entry: './main.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
  },
  target: 'web',
  mode: 'production',
  resolve: {
    fallback: { 'fs': false, 'path': false }
  }
};
