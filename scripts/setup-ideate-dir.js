#!/usr/bin/env node

/**
 * Setup script for creating .ideate/ directory structure
 * Usage: node setup-ideate-dir.js [target-directory]
 * Default target: current working directory
 */

const fs = require('fs');
const path = require('path');

// Get target directory from command line args or use current directory
const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const ideateDir = path.join(targetDir, '.ideate');

// Subdirectories to create with .gitkeep files
const subdirectories = [
  'work-items',
  'principles',
  'constraints',
  'modules',
  'plan',
  'research',
  'interviews',
  'policies',
  'decisions',
  'questions',
  'cycles'
];

// Config file content
const configContent = JSON.stringify({ schema_version: 2 }, null, 2);

function main() {
  try {
    // Check if .ideate already exists
    if (fs.existsSync(ideateDir)) {
      console.error(`Error: ${ideateDir} already exists`);
      process.exit(1);
    }

    // Create .ideate directory
    fs.mkdirSync(ideateDir, { recursive: true });
    console.log(`Created: ${ideateDir}`);

    // Create config.json
    const configPath = path.join(ideateDir, 'config.json');
    fs.writeFileSync(configPath, configContent);
    console.log(`Created: ${configPath}`);

    // Create subdirectories with .gitkeep files
    for (const subdir of subdirectories) {
      const subdirPath = path.join(ideateDir, subdir);
      fs.mkdirSync(subdirPath, { recursive: true });

      const gitkeepPath = path.join(subdirPath, '.gitkeep');
      fs.writeFileSync(gitkeepPath, '');

      console.log(`Created: ${subdirPath}/.gitkeep`);
    }

    console.log('\n.ideate/ directory structure created successfully');
    console.log(`Location: ${ideateDir}`);

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
