import {
  CmsApiError,
  CmsNotConfiguredError,
  type CmsClientEnv,
} from '@lionrockjs/worker-cms-plugin';

interface ContentMetaResponse {
  languages?: unknown;
}

/** Reads the host CMS's authoritative content-language registry. */
export async function cmsContentLanguages(
  env: CmsClientEnv,
  pluginId: string,
  pageType: string,
): Promise<string[]> {
  if (!env.CMS_URL || !env.PLUGIN_SECRET) throw new CmsNotConfiguredError();

  const path = `/content-meta?types=${encodeURIComponent(pageType)}`;
  const response = await fetch(`${env.CMS_URL.replace(/\/+$/, '')}/__cms${path}`, {
    headers: {
      'x-plugin-id': pluginId,
      'x-plugin-secret': env.PLUGIN_SECRET,
    },
  });
  if (!response.ok) throw new CmsApiError(response.status, 'content_meta_failed', 'GET', path);

  const body = await response.json() as ContentMetaResponse;
  if (!Array.isArray(body.languages)) {
    throw new CmsApiError(502, 'invalid_content_meta', 'GET', path);
  }

  const seen = new Set<string>();
  const languages: string[] = [];
  for (const value of body.languages) {
    if (typeof value !== 'string') continue;
    const language = value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/i.test(language) || seen.has(language)) continue;
    seen.add(language);
    languages.push(language);
  }
  if (!languages.length) throw new CmsApiError(502, 'empty_content_languages', 'GET', path);
  return languages;
}
