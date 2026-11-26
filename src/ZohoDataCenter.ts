import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
 * Zoho hosts each account in one data centre. OAuth and API calls must go to
 * the hosts of the data centre that holds the account.
 */
export const ZohoDataCenter = Schema.Literals(['us', 'eu', 'in', 'au', 'jp', 'ca', 'cn', 'sa', 'ae'])
export type ZohoDataCenter = typeof ZohoDataCenter.Type

export interface ZohoDataCenterHosts {
  readonly accounts: string
  readonly api: string
}

export const zohoDataCenters: { readonly [DataCenter in ZohoDataCenter]: ZohoDataCenterHosts } = {
  us: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com' },
  eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu' },
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in' },
  au: { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', api: 'https://www.zohoapis.ca' },
  cn: { accounts: 'https://accounts.zoho.com.cn', api: 'https://www.zohoapis.com.cn' },
  sa: { accounts: 'https://accounts.zoho.sa', api: 'https://www.zohoapis.sa' },
  ae: { accounts: 'https://accounts.zoho.ae', api: 'https://www.zohoapis.ae' },
}

const entries = Object.entries(zohoDataCenters) as ReadonlyArray<readonly [ZohoDataCenter, ZohoDataCenterHosts]>

const byHost = (host: keyof ZohoDataCenterHosts) => (origin: string): Option.Option<ZohoDataCenter> =>
  Option.fromUndefinedOr(entries.find(([, hosts]) => hosts[host] === origin)?.[0])

/**
 * The data centre Zoho names in the `location` parameter it adds to the OAuth
 * redirect, which uses the same codes as `ZohoDataCenter`.
 */
export const zohoDataCenterFromLocation: (location: string) => Option.Option<ZohoDataCenter> = Schema.decodeUnknownOption(ZohoDataCenter)

/**
 * The data centre whose accounts server is `origin`, such as the `accounts-server`
 * parameter of the OAuth redirect. Anything but an exact official origin is none,
 * so a forged parameter cannot send credentials elsewhere.
 */
export const zohoDataCenterFromAccountsServer: (origin: string) => Option.Option<ZohoDataCenter> = byHost('accounts')

/** The data centre whose API host is `origin`, such as a token grant's `api_domain`. Anything else is none. */
export const zohoDataCenterFromApiDomain: (origin: string) => Option.Option<ZohoDataCenter> = byHost('api')
