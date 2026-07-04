const { runCheckinTask } = require('./runner');

async function runEvening(options = {}) {
  return runCheckinTask('evening', options);
}

module.exports = { runEvening };
