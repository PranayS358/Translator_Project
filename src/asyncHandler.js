// Wraps an async Express route handler so a rejected promise (e.g. a
// transient database error) is forwarded to Express's error-handling
// middleware instead of becoming an unhandled promise rejection.
//
// Why this matters: none of the route handlers in src/routes/*.js had
// try/catch around their `await prisma.*` calls. Express 4 (unlike 5) does
// NOT catch rejected promises thrown inside async route handlers on its
// own — an uncaught rejection there kills the entire Node process. That's
// exactly what took the whole site down on 2026-08-05: Neon's free-tier
// Postgres had suspended itself from inactivity, one `/widget-api/messages`
// poll hit it mid-wakeup and got "Can't reach database server", and because
// nothing caught that error, it crashed the process — turning one visitor's
// one slow request into a 502 for every visitor until Render restarted the
// instance ~90 seconds later.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
