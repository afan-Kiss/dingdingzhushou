const { runCheckinTask } = require('./runner');

async function runMorning(options = {}) {
  return runCheckinTask('morning', options);
}

module.exports = { runMorning };
