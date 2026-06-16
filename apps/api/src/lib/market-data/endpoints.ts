// Provider base URLs. Mutable so tests can point a provider at a local mock server
// (see *.test.ts). Production uses the real hosts.
export const endpoints = {
  yahooChart: "https://query1.finance.yahoo.com/v8/finance/chart",
  yahooSearch: "https://query1.finance.yahoo.com/v1/finance/search",
  frankfurter: "https://api.frankfurter.app",
  alphavantage: "https://www.alphavantage.co/query",
};
