/**
 * Zoho hosts each account in one data centre. OAuth and API calls must go to
 * the hosts of the data centre that holds the account.
 */
export type ZohoDataCenter = 'us' | 'eu' | 'in' | 'au' | 'jp' | 'ca' | 'cn' | 'sa' | 'ae'

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
