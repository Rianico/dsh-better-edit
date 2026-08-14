export const HASH_LEN = 3;

export const ALPH =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const ALPH_SAFE = ALPH.replace(/-/g, "\\-");

export const ALPH_RE = new RegExp(`^[${ALPH_SAFE}]+$`);

export const HASH_CLASS = `[${ALPH_SAFE}]{${HASH_LEN}}`;

export const HASH_RE = new RegExp(`^${HASH_CLASS}$`);
