// Injection tokens for values that aren't classes. Constructor parameters are injected with an
// explicit @Inject() because the server runs through tsx, which doesn't emit decorator metadata.
export const CONFIG = Symbol("CONFIG");
export const MAILER = Symbol("MAILER");
export const PAYMENTS = Symbol("PAYMENTS");
export const HELP_MODEL = Symbol("HELP_MODEL");
export const HELP_KNOWLEDGE = Symbol("HELP_KNOWLEDGE");
