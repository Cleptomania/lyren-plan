// ErrorState's "can't reach the server" text, rendered to HTML (no DOM needed).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { authErrorMessage } from '../../features/auth/authErrors';
import { ErrorState } from './ErrorState';

const networkError = () => new ApiError(0, 'network_error', 'x');
const render = () => renderToStaticMarkup(createElement(ErrorState, { error: networkError(), onRetry: () => undefined }));

function atHost(hostname: string) {
  Object.defineProperty(globalThis, 'location', { value: { hostname }, configurable: true });
}

describe('ErrorState for a server that cannot be reached', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'location');
  });

  it('the desktop app (127.0.0.1): asks to start Lyren Plan again', () => {
    atHost('127.0.0.1');
    const html = render();
    expect(html).toContain('Can’t reach Lyren Plan');
    expect(html).toContain('If Lyren Plan runs on this computer, start it again (it must keep running while you use it), then try again.');
    expect(html).toContain('Try again');
    expect(html).not.toContain('connection');
    expect(authErrorMessage(networkError())).toMatch(/^Can’t reach Lyren Plan\. If it runs on this computer, start it again/);
  });

  it('a server elsewhere: check the connection', () => {
    atHost('plan.example.org');
    const html = render();
    expect(html).toContain('Can’t reach the server');
    expect(html).toContain('Check your connection and try again.');
    expect(authErrorMessage(networkError())).toBe('Can’t reach the server. Check your connection and try again.');
  });
});
