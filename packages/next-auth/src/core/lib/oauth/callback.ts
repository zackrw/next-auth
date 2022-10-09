import { TokenSet } from "openid-client"
import { openidClient } from "./client"
import { oAuth1Client } from "./client-legacy"
import { useState } from "./state-handler"
import { usePKCECodeVerifier } from "./pkce-handler"
import { useNonce } from "./nonce-handler"
import { OAuthCallbackError } from "../../errors"

import type { CallbackParamsType, OpenIDCallbackChecks } from "openid-client"
import type { LoggerInstance, Profile } from "../../.."
import type { OAuthConfigInternal } from "../../../providers"
import type { InternalOptions } from "../../types"
import type { InternalRequest } from "../.."
import type { Cookie } from "../cookie"

export default async function oAuthCallback(params: {
  options: InternalOptions<"oauth">
  query: InternalRequest["query"]
  body: InternalRequest["body"]
  method: Required<InternalRequest>["method"]
  cookies: InternalRequest["cookies"]
}) {
  const { options, query, body, method, cookies } = params
  const { logger, provider } = options

  const errorMessage = body?.error ?? query?.error
  if (errorMessage) {
    const error = new Error(errorMessage)
    logger.error("OAUTH_CALLBACK_HANDLER_ERROR", {
      error,
      error_description: query?.error_description,
      providerId: provider.id,
    })
    logger.debug("OAUTH_CALLBACK_HANDLER_ERROR", { body })
    throw error
  }

  if (provider.version?.startsWith("1.")) {
    try {
      const client = await oAuth1Client(options)
      // Handle OAuth v1.x
      const { oauth_token, oauth_verifier } = query ?? {}
      const tokens = (await (client as any).getOAuthAccessToken(
        oauth_token,
        null,
        oauth_verifier
      )) as TokenSet
      let profile: Profile = await (client as any).get(
        provider.profileUrl,
        tokens.oauth_token,
        tokens.oauth_token_secret
      )

      if (typeof profile === "string") {
        profile = JSON.parse(profile)
      }

      const newProfile = await getProfile({ profile, tokens, provider, logger })
      return { ...newProfile, cookies: [] }
    } catch (error) {
      logger.error("OAUTH_V1_GET_ACCESS_TOKEN_ERROR", error as Error)
      throw error
    }
  }

  try {
    const client = await openidClient(options)

    let tokens: TokenSet

    const checks: OpenIDCallbackChecks = {}
    const resCookies: Cookie[] = []

    const state = await useState(cookies?.[options.cookies.state.name], options)
    if (state) {
      checks.state = state.value
      resCookies.push(state.cookie)
    }

    const nonce = await useNonce(cookies?.[options.cookies.nonce.name], options)
    if (nonce && provider.idToken) {
      checks.nonce = nonce.value
      resCookies.push(nonce.cookie)
    }

    const codeVerifier = cookies?.[options.cookies.pkceCodeVerifier.name]
    const pkce = await usePKCECodeVerifier(codeVerifier, options)
    if (pkce) {
      checks.code_verifier = pkce.codeVerifier
      resCookies.push(pkce.cookie)
    }

    const params: CallbackParamsType = {
      ...client.callbackParams({
        url: `http://n?${new URLSearchParams(query)}`,
        // TODO: Ask to allow object to be passed upstream:
        // https://github.com/panva/node-openid-client/blob/3ae206dfc78c02134aa87a07f693052c637cab84/types/index.d.ts#L439
        // @ts-expect-error
        body,
        method,
      }),
      ...Object.fromEntries(provider.token?.url.searchParams.entries() ?? []),
    }

    if (provider.token?.request) {
      const response = await provider.token.request({
        provider,
        params,
        checks,
        client,
      })
      tokens = new TokenSet(response.tokens)
    } else if (provider.idToken) {
      tokens = await client.callback(provider.callbackUrl, params, checks)
    } else {
      tokens = await client.oauthCallback(provider.callbackUrl, params, checks)
    }

    // REVIEW: How can scope be returned as an array?
    if (Array.isArray(tokens.scope)) {
      tokens.scope = tokens.scope.join(" ")
    }

    let profile: Profile
    if (provider.userinfo?.request) {
      profile = await provider.userinfo.request({
        provider,
        tokens,
        client,
      })
    } else if (provider.idToken) {
      profile = tokens.claims()
    } else {
      const params = Object.fromEntries(
        provider.userinfo?.url.searchParams.entries() ?? []
      )
      profile = await client.userinfo(tokens, { params })
    }

    const profileResult = await getProfile({
      profile,
      provider,
      tokens,
      logger,
    })
    return { ...profileResult, cookies: resCookies }
  } catch (error) {
    throw new OAuthCallbackError(error as Error)
  }
}

export interface GetProfileParams {
  profile: Profile
  tokens: TokenSet
  provider: OAuthConfigInternal<any>
  logger: LoggerInstance
}

/** Returns profile, raw profile and auth provider details */
async function getProfile({
  profile: OAuthProfile,
  tokens,
  provider,
  logger,
}: GetProfileParams) {
  try {
    logger.debug("PROFILE_DATA", { OAuthProfile })
    const profile = await provider.profile(OAuthProfile, tokens)
    profile.email = profile.email?.toLowerCase()
    if (!profile.id)
      throw new TypeError(
        `Profile id is missing in ${provider.name} OAuth profile response`
      )

    // Return profile, raw profile and auth provider details
    return {
      profile,
      account: {
        provider: provider.id,
        type: provider.type,
        providerAccountId: profile.id.toString(),
        ...tokens,
      },
      OAuthProfile,
    }
  } catch (error) {
    // If we didn't get a response either there was a problem with the provider
    // response *or* the user cancelled the action with the provider.
    //
    // Unfortuately, we can't tell which - at least not in a way that works for
    // all providers, so we return an empty object; the user should then be
    // redirected back to the sign up page. We log the error to help developers
    // who might be trying to debug this when configuring a new provider.
    logger.error("OAUTH_PARSE_PROFILE_ERROR", {
      error: error as Error,
      OAuthProfile,
    })
  }
}
