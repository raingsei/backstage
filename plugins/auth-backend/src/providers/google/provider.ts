/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import passport from 'passport';
import express, { CookieOptions } from 'express';
import crypto from 'crypto';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import refresh from 'passport-oauth2-refresh';
import {
  AuthProvider,
  AuthProviderRouteHandlers,
  AuthProviderConfig,
} from './../types';
import { postMessageResponse, ensuresXRequestedWith } from './../utils';
import { InputError } from '@backstage/backend-common';

export const THOUSAND_DAYS_MS = 1000 * 24 * 60 * 60 * 1000;
export const TEN_MINUTES_MS = 600 * 1000;
export class GoogleAuthProvider
  implements AuthProvider, AuthProviderRouteHandlers {
  private readonly providerConfig: AuthProviderConfig;
  constructor(providerConfig: AuthProviderConfig) {
    this.providerConfig = providerConfig;
  }

  start(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    const nonce = crypto.randomBytes(16).toString('base64');

    const options: CookieOptions = {
      maxAge: TEN_MINUTES_MS,
      secure: false,
      sameSite: 'none',
      domain: 'localhost',
      path: `/auth/${this.providerConfig.provider}/handler`,
      httpOnly: true,
    };

    res.cookie(`${this.providerConfig.provider}-nonce`, nonce, options);

    const scope = req.query.scope?.toString() ?? '';
    if (!scope) {
      throw new InputError('missing scope parameter');
    }
    return passport.authenticate('google', {
      scope,
      accessType: 'offline',
      prompt: 'consent',
      state: nonce,
    })(req, res, next);
  }

  frameHandler(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    const cookieNonce = req.cookies[`${this.providerConfig.provider}-nonce`];
    const stateNonce = req.query.state;

    if (!cookieNonce || !stateNonce) {
      return res.status(401).send('Missing nonce');
    }

    if (cookieNonce !== stateNonce) {
      return res.status(401).send('Invalid nonce');
    }

    return passport.authenticate('google', (err, user) => {
      if (err) {
        return postMessageResponse(res, {
          type: 'auth-result',
          error: new Error(`Google auth failed, ${err}`),
        });
      }

      const { refreshToken } = user;

      if (!refreshToken) {
        return postMessageResponse(res, {
          type: 'auth-result',
          error: new Error('Missing refresh token'),
        });
      }

      delete user.refreshToken;

      const options: CookieOptions = {
        maxAge: THOUSAND_DAYS_MS,
        secure: false,
        sameSite: 'none',
        domain: 'localhost',
        path: `/auth/${this.providerConfig.provider}`,
        httpOnly: true,
      };

      res.cookie(
        `${this.providerConfig.provider}-refresh-token`,
        refreshToken,
        options,
      );
      return postMessageResponse(res, {
        type: 'auth-result',
        payload: user,
      });
    })(req, res, next);
  }

  async logout(req: express.Request, res: express.Response) {
    if (!ensuresXRequestedWith(req)) {
      return res.status(401).send('Invalid X-Requested-With header');
    }

    const options: CookieOptions = {
      maxAge: 0,
      secure: false,
      sameSite: 'none',
      domain: 'localhost',
      path: `/auth/${this.providerConfig.provider}`,
      httpOnly: true,
    };

    res.cookie(`${this.providerConfig.provider}-refresh-token`, '', options);
    return res.send('logout!');
  }

  async refresh(req: express.Request, res: express.Response) {
    if (!ensuresXRequestedWith(req)) {
      return res.status(401).send('Invalid X-Requested-With header');
    }

    const refreshToken =
      req.cookies[`${this.providerConfig.provider}-refresh-token`];

    if (!refreshToken) {
      return res.status(401).send('Missing session cookie');
    }

    const scope = req.query.scope?.toString() ?? '';
    const refreshTokenRequestParams = scope ? { scope } : {};

    return refresh.requestNewAccessToken(
      this.providerConfig.provider,
      refreshToken,
      refreshTokenRequestParams,
      (err, accessToken, _refreshToken, params) => {
        if (err || !accessToken) {
          return res.status(401).send('Failed to refresh access token');
        }
        return res.send({
          accessToken,
          idToken: params.id_token,
          expiresInSeconds: params.expires_in,
          scope: params.scope,
        });
      },
    );
  }

  strategy(): passport.Strategy {
    // TODO: throw error if env variables not set?
    return new GoogleStrategy(
      { ...this.providerConfig.options },
      (
        accessToken: any,
        refreshToken: any,
        params: any,
        profile: any,
        done: any,
      ) => {
        done(undefined, {
          profile,
          idToken: params.id_token,
          accessToken,
          refreshToken,
          scope: params.scope,
          expiresInSeconds: params.expires_in,
        });
      },
    );
  }
}
