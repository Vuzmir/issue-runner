// The one HTTP primitive both installers need: a GET that fails loudly instead of handing
// back an error page as if it were the document that was asked for.

export async function getText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}.`);
  return await response.text();
}
