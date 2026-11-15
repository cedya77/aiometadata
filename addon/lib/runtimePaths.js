// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const fs = require('fs');
const path = require('path');

const appRoot = process.cwd();
const packageJsonPath = path.join(appRoot, 'package.json');

if (!fs.existsSync(packageJsonPath)) {
  throw new Error(`Runtime app root is invalid: package.json not found at ${packageJsonPath}`);
}

module.exports = {
  appRoot,
  clientDistDir: path.join(appRoot, 'dist', 'client'),
  clientIndexPath: path.join(appRoot, 'dist', 'client', 'index.html'),
  publicDir: path.join(appRoot, 'public'),
};
