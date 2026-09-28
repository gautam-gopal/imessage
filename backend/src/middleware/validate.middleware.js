export function validate(schema, source = "body") {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const err = new Error(
        result.error.issues[0]?.message || "Invalid request",
      );
      err.statusCode = 400;
      return next(err);
    }

    // Express 5: req.query is a getter-only property, so it cannot be
    // reassigned. Parsed query data is exposed on req.validatedQuery.
    if (source === "query") {
      req.validatedQuery = result.data;
    } else {
      req[source] = result.data;
    }
    next();
  };
}
