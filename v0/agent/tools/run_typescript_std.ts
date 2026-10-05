/** The libraries admitted by run_typescript; ordinary fetch is independent of this policy. */
export const requireStdSpecifier = (specifier: string): void => {
  if (!/^jsr:@std\/[a-z0-9_-]+(?:@[^/]+)?(?:\/.*)?$/u.test(specifier)) {
    throw new Error(`Only Deno std imports are allowed: ${specifier}`);
  }
};

export const requireStdUrl = (url: URL): void => {
  if (
    url.origin !== 'https://jsr.io' || url.username || url.password ||
    !/^\/@std\/[a-z0-9_-]+\/\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\/.+/u.test(
      url.pathname,
    )
  ) {
    throw new Error(`Only Deno std imports are allowed: ${url.href}`);
  }
};
