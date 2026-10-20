// The heavy part of <Markdown> (react-markdown + remark-gfm), loaded lazily.

import { clsx } from 'clsx';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);/i;

/**
 * Whether Markdown's `![](url)` becomes a real <img>: raster data: images and same-origin files, never a path the
 * API answers (design §13.4: an <img> of /api/… would be a request with the reader's session, for whatever the
 * author of the text put there). Everything else is shown as a link.
 */
export function rendersAsImage(url: string): boolean {
  if (DATA_IMAGE.test(url)) return true;
  return isSameOrigin(url) && !isApiPath(url);
}

/** A same-origin path under /api: neither an image nor a link, only its text. */
function isApiPath(url: string): boolean {
  return isSameOrigin(url) && /^\/api(?:\/|$)/i.test(new URL(url, window.location.href).pathname);
}

// Keep raster data: images (the default transform drops every data: URL); everything else
// goes through react-markdown's safe-protocol filter (no javascript: etc.).
const urlTransform: UrlTransform = (url, key) => (key === 'src' && DATA_IMAGE.test(url) ? url : defaultUrlTransform(url));

const components: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ node: _node, src, alt, title }) => {
    const url = typeof src === 'string' ? src : '';
    if (url && rendersAsImage(url)) {
      return <img src={url} alt={alt ?? ''} title={title} loading="lazy" decoding="async" />;
    }
    if (url && isApiPath(url)) return <span>{alt || url}</span>;
    // Remote images are blocked (CSP; no outbound requests) — show a link instead.
    return url ? (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {alt || url}
      </a>
    ) : (
      <span>{alt}</span>
    );
  },
};

const plugins = [remarkGfm];

export default function MarkdownRenderer({ source, className }: { source: string; className?: string }) {
  return (
    <div className={clsx('markdown', className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
