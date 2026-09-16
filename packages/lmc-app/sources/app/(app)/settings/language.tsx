import { Redirect } from 'expo-router';
/** The language is a menu on the general settings row now, not a page of its own. */
export default function RetiredLanguageRoute() { return <Redirect href="/settings/appearance" />; }
