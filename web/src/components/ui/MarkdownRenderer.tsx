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
    if (url && (DATA_IMAGE.test(url) || isSameOrigin(url))) {
      return <img src={url} alt={alt ?? ''} title={title} loading="lazy" decoding="async" />;
    }
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
