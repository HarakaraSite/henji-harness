/** Nonsecret ChatGPT account and login projections exposed by Core. */
export type ChatGPTState = Readonly<{
  selectedRegistrationId?: string;
  accounts: readonly Readonly<{
    registrationId: string;
    label: string;
    needsReauthentication: boolean;
  }>[];
}>;

export type ChatGPTLoginAttempt = Readonly<{
  attemptId: string;
  registrationId: string;
  authorizationUrl: string;
}>;

export type ChatGPTOperation =
  | Readonly<{ kind: 'status' }>
  | Readonly<{ kind: 'begin'; registrationId?: string }>
  | Readonly<{ kind: 'complete'; attemptId: string; callbackUrl: string }>
  | Readonly<{ kind: 'cancel'; attemptId: string }>
  | Readonly<{ kind: 'select'; registrationId: string }>;

export type ChatGPTAuthResult =
  | Readonly<{ kind: 'chatgpt'; state: ChatGPTState; attempt?: ChatGPTLoginAttempt }>
  | Readonly<{ kind: 'rejected'; reason: string }>;
