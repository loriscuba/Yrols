/**
 * Tipi dell'API Enable Banking (solo i campi usati dal connettore)
 * e tipi normalizzati consumati dal cruscotto Yrols.
 */

// ---------------------------------------------------------------------------
// API Enable Banking (risposte "raw")
// ---------------------------------------------------------------------------

export interface EbAmount {
  currency: string;
  amount: string;
}

export interface EbAccountIdentification {
  iban?: string;
  other?: { identification: string; scheme_name?: string };
}

export interface EbAccount {
  uid: string;
  account_id?: EbAccountIdentification;
  name?: string;
  details?: string;
  product?: string;
  currency?: string;
  cash_account_type?: string;
  usage?: string;
  identification_hash?: string;
}

export interface EbAspsp {
  name: string;
  country: string;
  logo?: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
  beta?: boolean;
  bic?: string;
}

export interface EbAuthRequest {
  access: { valid_until: string };
  aspsp: { name: string; country: string };
  state: string;
  redirect_url: string;
  psu_type?: "personal" | "business";
  language?: string;
}

export interface EbAuthResponse {
  url: string;
  authorization_id: string;
  psu_id_hash?: string;
}

export interface EbSession {
  session_id: string;
  accounts: EbAccount[];
  aspsp: { name: string; country: string };
  psu_type?: string;
  access: { valid_until: string };
}

export interface EbSessionStatus {
  status: string;
  accounts: string[];
  accounts_data?: EbAccount[];
  aspsp: { name: string; country: string };
  psu_type?: string;
  access: { valid_until: string };
  created?: string;
  authorized?: string;
  closed?: string;
}

export interface EbBalance {
  name?: string;
  balance_amount: EbAmount;
  balance_type: string;
  last_change_date_time?: string;
  reference_date?: string;
  last_committed_transaction?: string;
}

export interface EbBalancesResponse {
  balances: EbBalance[];
}

export interface EbParty {
  name?: string;
}

export interface EbTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  merchant_category_code?: string | null;
  transaction_amount: EbAmount;
  creditor?: EbParty | null;
  creditor_account?: EbAccountIdentification | null;
  debtor?: EbParty | null;
  debtor_account?: EbAccountIdentification | null;
  bank_transaction_code?: { description?: string; code?: string; sub_code?: string } | null;
  credit_debit_indicator: "CRDT" | "DBIT";
  status: "BOOK" | "PDNG" | "CNCL" | "HOLD" | "OTHR" | "INFO" | "SCHD" | "RJCT";
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  balance_after_transaction?: EbAmount | null;
  reference_number?: string | null;
  remittance_information?: string[] | null;
  note?: string | null;
}

export interface EbTransactionsResponse {
  transactions: EbTransaction[];
  continuation_key?: string | null;
}

// ---------------------------------------------------------------------------
// Formato normalizzato (contratto con il cruscotto, vedi docs/contratto)
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  iban?: string;
  name?: string;
  currency?: string;
  bankName?: string;
  connectionId?: string;
}

export interface Balance {
  accountId: string;
  /** Numero con segno: negativo = debito. */
  amount: number;
  currency: string;
  /** Codice ISO 20022 (CLBD, ITAV, XPCD, ...). */
  type: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  /** Negativo = uscita, positivo = entrata. */
  amount: number;
  currency: string;
  bookingDate: string;
  valueDate?: string;
  description: string;
  counterparty?: string;
  status: "BOOK" | "PDNG";
}

export interface Connection {
  /** session_id Enable Banking */
  id: string;
  bankName: string;
  country: string;
  validUntil: string;
  status: "active" | "expired" | "revoked";
}

export interface SyncPayload {
  source: "enablebanking";
  syncedAt: string;
  connections?: Connection[];
  accounts?: Account[];
  balances?: Balance[];
  transactions?: Transaction[];
}
