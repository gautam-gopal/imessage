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

    req[source] = result.data;
    next();
  };
}
