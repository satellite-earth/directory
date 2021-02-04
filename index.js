const Parcel = require('@satellite-earth/parcel');
const utils = require('@satellite-earth/utils');

// Select address from records at block number
const select = (records, which, at) => {
	for (let record of records) {
		const value = record[which];
		const match = at >= record.block;
		if (match && typeof value !== 'undefined') {
			return value;
		}
	}
};

// Remove meaningless zeros from bytes32 hex string
const pare = (s) => {
	for (let z = 66; z >= 0; z--) {
		if (s[z - 1] !== '0') {
			return z % 2 ? s.substring(2, z + 1) : s.substring(2, z);
		}
	}
};

// An in-memory directory of alias IDs built from Etheruem log data
// to faciliate the synchronous verification of signed messages.
class Directory {

	constructor (filter) {

		// If provided the function will be called on
		// each alias, only including those for which
		// it returns a truthy value in the directory
		this.filter = filter;

		// null until call to synchonize() is made
		this.blockNumber = null;

		// Model relationship between aliases
		// and addresses in relation to block
		this.map = {
			address: {},
			alias: {}
		};
	}

	// Restore directory state from compressed data
	inflate (data) {
		const parcel = new Parcel(data);
		const { blockNumber, map } = parcel.unpacked;
		this.blockNumber = blockNumber;
		this.map = map;
	}

	// Use the supplied core API instance
	// to build the directory from logs
	async synchronize (eth, _toBlock) {

		let toBlock = _toBlock;

		// If toBlock not specified, start sync from latest detected block
		// number with 12 blocks buffer to allow for adequate confirmation
		if (typeof toBlock === 'undefined') {

			if (!eth || !eth.getBlockNumber) {
				throw Error('Missing eth interface function \'getBlockNumber\'');
			}

			const latest = await eth.getBlockNumber();
			toBlock = latest - 12;
		}

		// Get all contract events in the given block range
		const range = { fromBlock: this.blockNumber, toBlock };
		let logs;

		// If toBlock is not greater than last synced block, return empty update
		if (this.initialized && toBlock <= this.blockNumber) {
			console.log('skipped directory sync');
			return [];
		}

		if (!eth || !eth.getDirectoryLog) {
			throw Error('Missing eth interface function \'getDirectoryLog\'');
		}

		// Get directory logs with the provided function
		logs = await eth.getDirectoryLog(range);

		// Sort by block and transaction index to ensure array
		// order matches blockchain's sequence of execution
		logs.sort((a, b) => {
			const _a = a.blockNumber;
			const _b = b.blockNumber;
			return _a === _b ? a.transactionIndex - b.transactionIndex : _a - _b;
		});

		for (let log of logs) { // Iterate over directory logs

			const { data, blockNumber } = log;
			const alias = pare(data.name);
			const insert = { block: blockNumber };

			// Apply filter function if defined
			if (this.filter && !this.filter(alias)) {
				continue;
			}

			// Assign primary record if any
			if (typeof data.primary !== 'undefined') {
				insert.primary = data.primary;
				if (data.primary !== null) {
					insert.primary = data.primary.toLowerCase();
				}
			}

			// Assign recovery record if any
			if (typeof data.recovery !== 'undefined') {
				insert.recovery = data.recovery;
				if (data.recovery !== null) {
					insert.recovery = data.recovery.toLowerCase();
				}
			}

			// Initialize address record array for new aliases
			if (!this.map.alias[alias]) {
				this.map.alias[alias] = [];
			}

			// Push the new record to front of array
			this.map.alias[alias].unshift(insert);

			// If updating primary, point to alias
			if (insert.primary) {
				this.map.address[insert.primary] = alias;
			}
		}

		// Save last block number synced
		this.blockNumber = toBlock;

		// The point of returning the logs is just to provide
		// a convenient hook for creating external ops/events
		return logs;
	}

	// Returns array of current alias info
	list (options = {}) {

		// Iterate across each alias record list
		return Object.keys(this.map.alias).map(alias => {

			let primary;
			let recovery = null;

			// Find most recent record for each address (if any)
			for (let record of this.map.alias[alias]) {

				if (!primary && record.primary) {
					primary = record.primary;
				}

				if (!recovery && record.recovery) {
					recovery = record.recovery;
				}

				if (primary && recovery) {
					break;
				}
			}

			return {
				alias: options.utf8 ? utils.hexToUtf8('0x' + alias) : alias,
				primary,
				recovery
			};
		});
	}

	// Get alias name that address was linked to at given block number
	getAlias (primary, options = {}) {

		if (!this.initialized) {
			throw Error('Directory not initialized');
		}

		if (options.at && options.at > this.blockNumber) {
			throw Error('Directory not sufficiently advanced');
		}

		// Alias that the address was linked to at some point
		const lower = primary.toLowerCase();
		const alias = this.map.address[lower];

		// If address has never been linked, return undefined
		if (!alias) { return; }

		// If address matches address linked to alias at block number, return alias
		const addr = select(this.getRecords(alias, options), 'primary', options.at);
		if (addr && addr === lower) {
			return options.utf8 ? utils.hexToUtf8('0x' + alias) : alias;
		}

		return;
	}

	// Get primary address for alias at given block number
	getPrimary (alias, options = {}) {
		return select(this.getRecords(alias, options), 'primary', options.at);
	}

	// Get recovery address (if any) for alias at given block number
	getRecovery (alias, options = {}) {
		return select(this.getRecords(alias, options), 'recovery', options.at);
	}

	// Return all records for a given alias
	getRecords (alias, options = {}) {

		// If option.utf8 convert to hex for lookup
		const _alias = options.utf8 ? pare(utils.utf8ToHex(alias)) : alias;

		// Return address records for alias, if any
		return this.map.alias[_alias] || [];
	}

	get initialized () {
		return this.blockNumber !== null;
	}

	// Return compressed directory state, which can then
	// be used to reinflate the alias directory. This is
	// useful for distributing the data as a torrent.
	get compressed () {
		const parcel = new Parcel({
			blockNumber: this.blockNumber,
			map: this.map
		});
		return parcel.packed;
	}
}

module.exports = Directory;

