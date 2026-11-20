// The texts of the page the system browser shows after "Sign in with Discord" (server/lib/accounts/authpage.mjs
// serves it from web/i18n/<lang>.json – this list is where the keys are declared, so they are extracted and translated
// like every other text). The app shows the first one itself too, as the toast after signing in.
import { t } from './i18n.mjs';

export const authTexts = () => ({
  okTitle: t('auth.okTitle', 'You’re signed in'),
  okText: t('auth.okText', 'You can close this tab and go back to souldew.'),
  failTitle: t('auth.failTitle', 'Signing in didn’t work'),
  failText: t('auth.failText', 'Go back to souldew and try again.'),
  deniedTitle: t('auth.deniedTitle', 'Sign-in cancelled'),
  deniedText: t('auth.cancelledText', 'You cancelled the sign-in – nothing was shared with souldew. You can close this tab.'),
  mismatchText: t('auth.mismatchText', 'This sign-in link doesn’t belong to the sign-in souldew started. Go back to souldew and start again.'),
  expiredText: t('auth.expiredText', 'This sign-in took too long. Go back to souldew and start again.'),
  offlineText: t('auth.offlineText', 'souldew couldn’t reach the account service. Check your internet connection, then try again in souldew.'),
  suspendedText: t('auth.suspendedText', 'This souldew account is suspended.'),
});
