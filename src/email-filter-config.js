export const BLOCKED_EMAIL_LOCAL_PARTS = new Set([
  "user", "username", "name", "email", "test", "example", "sample", "demo", "fake",
  "dummy", "temp", "temporary", "placeholder", "noreply", "no-reply", "donotreply",
  "do-not-reply", "nobody", "null", "none", "firstname", "lastname", "first.last",
  "firstname.lastname", "yourname", "your", "you", "me", "abc", "abc123", "123",
  "1234", "12345", "xxx", "x", "a", "aa", "aaa", "asdf", "qwerty", "spam",
  "junk", "invalid", "unknown", "notavailable", "unavailable", "na", "n-a",
  "noemail", "no-email", "notprovided", "not-provided", "missing", "blank", "insert",
  "enter", "enteremail", "emailaddress", "email.address", "your.email", "your-email",
  "someone", "somebody", "person", "customer", "client", "guest", "anonymous", "anon",
  "account"
]);

export const BLOCKED_EMAIL_ADDRESSES = new Set([]);

export const BLOCKED_EMAIL_DOMAINS = new Set([
  "example.com",
  "domain.com"
]);

export const CONDITIONAL_PLACEHOLDER_DOMAINS = new Set([
  "email.com",
  "test.com"
]);
