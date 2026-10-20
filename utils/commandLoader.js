/**
 * Command Loader - Separate module to avoid circular dependencies
 * Updated: supports both single command exports and array exports
 */

const fs   = require('fs');
const path = require('path');

const loadCommands = () => {
  const commands    = new Map();
  const commandsPath = path.join(__dirname, '..', 'commands');

  if (!fs.existsSync(commandsPath)) {
    console.log('Commands directory not found');
    return commands;
  }

  const categories = fs.readdirSync(commandsPath);

  categories.forEach(category => {
    const categoryPath = path.join(commandsPath, category);
    if (!fs.statSync(categoryPath).isDirectory()) return;

    const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'));

    files.forEach(file => {
      try {
        const exported = require(path.join(categoryPath, file));

        // Support both module.exports = { name, ... }
        // AND         module.exports = [ { name, ... }, { name, ... } ]
        const commandList = Array.isArray(exported) ? exported : [exported];

        commandList.forEach(command => {
          if (command && command.name) {
            commands.set(command.name, command);
            if (command.aliases) {
              command.aliases.forEach(alias => commands.set(alias, command));
            }
          }
        });

      } catch (error) {
        console.error(`Error loading command ${file}:`, error.message);
      }
    });
  });

  return commands;
};

module.exports = { loadCommands };
