# App — Production Checklist

## Environment Variables

- [ ] `EXPO_PUBLIC_API_URL` — set to the production server URL (e.g. `https://api.breadsheet.com`). Currently defaults to `http://localhost:3000`
- [ ] `EXPO_PUBLIC_SUPABASE_URL` — production Supabase project URL
- [ ] `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` — production Supabase anon key
- [ ] `EXPO_PUBLIC_AUTH_REDIRECT_URL` — set to `https://api.breadsheet.com/auth/callback` (the server's redirect endpoint that bounces users back into the app after email verification)

## Supabase

- [ ] Switch from DEV Supabase project to a dedicated production project
- [ ] Enable email confirmation for new signups (currently a fresh signup proceeds without verification in DEV)
- [ ] Set anonymous user cap to limit account farming
- [ ] Configure auth email templates (verification, password reset) with production branding

## Build

- [ ] Run `npm run lint` — no errors
- [ ] Test on a physical iOS device and Android device, not just simulators
- [ ] Set `app.json` / `app.config.js` bundle identifiers, version, and build number correctly
- [ ] Production EAS build: `eas build --platform all --profile production`

## Security

- [ ] Confirm `EXPO_PUBLIC_API_URL` is HTTPS in production — the app will send Bearer tokens over this connection
- [ ] No `console.log` statements containing tokens or user data
- [ ] Consider replacing the `breadsheet://` custom scheme deep link with iOS Universal Links and Android App Links — custom schemes can be claimed by any app on the device, HTTPS deep links cannot. Requires hosting `.well-known/apple-app-site-association` and `.well-known/assetlinks.json` on the production domain and configuring `associatedDomains` in `app.json`

## App Store

- [ ] Privacy policy URL set in App Store Connect / Google Play Console
- [ ] Camera permission description string added to `app.json` (required before TICKET-004 barcode scanner ships)
- [ ] App icon and splash screen finalised

## Before Each Release

- [ ] Bump `version` in `app.json`
- [ ] Test the full auth flow: guest login → upgrade → sign out → sign back in
- [ ] Test on both light and dark mode
