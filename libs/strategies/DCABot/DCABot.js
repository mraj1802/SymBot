'use strict';

const fs = require('fs');
const path = require('path');

let pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);
pathRoot = pathRoot.substring(0, pathRoot.lastIndexOf('/'));


const colors = require('colors');
const delay = require('delay');
const ccxt = require('ccxt');
const { v4: uuidv4 } = require('uuid');
const Table = require('easy-table');
const Percentage = require('percentagejs');
const Common = require(pathRoot + '/Common.js');
const Schema = require(pathRoot + '/mongodb/DCABotSchema');

const Bots = Schema.Bots;
const Deals = Schema.Deals;

const prompt = require('prompt-sync')({
	sigint: true
});


const insufficientFundsMsg = 'Your wallet does not have enough funds for all DCA orders!';


let dealTracker = {};
let shareData;

let counter = 0;

async function start(data, startBot, reload) {

	data = await initBot(JSON.parse(JSON.stringify(data)));

	const config = Object.freeze(JSON.parse(JSON.stringify(data)));

	let exchange;
	let dealIdMain;
	let botActive = true;

	let totalOrderSize = 0;
	let totalAmount = 0;

	let pair = '';
	let pairConfig = config.pair;
	let botIdMain = config.botId;
	let dealCount = config.dealCount;
	let dealMax = config.dealMax;

	//await update(botIdMain, { 'active': false });

	if (dealCount == undefined || dealCount == null) {

		dealCount = 0;
	}

	if (dealMax == undefined || dealMax == null) {

		dealMax = 0;
	}

	try {
	
		exchange = new ccxt.pro[config.exchange]({

			'apiKey': config.apiKey,
			'secret': config.apiSecret,
			'passphrase': config.apiPassphrase,
			'password': config.apiPassword,			
		});
	}
	catch(e) {

		return ( { 'success': false, 'data': 'Invalid exchange: ' + config.exchange } );
	}


	try {

		//Load markets
		//const markets = await exchange.loadMarkets();

		if (pairConfig == undefined || pairConfig == null || pairConfig == '') {

			//pair = prompt(colors.bgGreen('Please enter pair (BASE/QUOTE): '));
			return;
		}
		else {

			pair = pairConfig;
		}

		pair = pair.toUpperCase();

		if (!reload) {

			if (shareData.appData.verboseLog) { Common.logger(colors.green('Getting pair information for ' + pair + '...')); }
		}

		const isActive = await checkActiveDeal(pair);
		const symbolData = await getSymbol(exchange, pair);
		const symbol = symbolData.info;

		// Check for valid symbol data on start
		if (symbolData.invalid) {

			if (Object.keys(dealTracker).length == 0) {

				//process.exit(0);
			}

			return ( { 'success': false, 'data': 'Invalid Pair' } );
		}
		else if (symbolData.error != undefined && symbolData.error != null) {

			return ( { 'success': false, 'data': JSON.stringify(symbolData.error) } );
		}

		let askPrice = symbol.askPrice;

		if (symbol.askPrice == undefined || symbol.askPrice == null) {

			askPrice = symbol.ask;
		}

		//await delay(1000);

		var t = new Table();
		const orders = [];

		if (isActive) {

			dealIdMain = isActive.dealId;

			if (!reload) {

				// Active deal found so get original config from db and restart bot

				if (dealTracker[isActive.dealId] != undefined && dealTracker[isActive.dealId] != null) {

					let msg = 'Deal ID ' + isActive.dealId + ' already running for ' + pair + '...';

					if (shareData.appData.verboseLog) { Common.logger( colors.bgCyan.bold(msg) ); }

					return ( { 'success': false, 'data': msg } );
				}

				if (shareData.appData.verboseLog) { Common.logger( colors.bgCyan.bold('Found active DCA deal for ' + pair + '...') ); }

				let configObj = JSON.parse(JSON.stringify(isActive.config));

				start(configObj, true, true);

				return;
			}
			else {

				// Config reloaded from db so bot and continue
				//await delay(1000);

				let followSuccess = false;
				let followFinished = false;

				while (!followSuccess && !followFinished) {

					let followRes = await dcaFollow(config, exchange, isActive.dealId);

					followSuccess = followRes['success'];
					followFinished = followRes['finished'];

					if (!followSuccess) {

						await delay(1000);
					}
				}

				if (followFinished) {

					//break;
				}
			}
		}
		else {

			let lastDcaOrderAmount = 0;
			let lastDcaOrderSize = 0;
			let lastDcaOrderSum = 0;
			let lastDcaOrderQtySum = 0;
			let lastDcaOrderPrice = 0;

			if (config.firstOrderType.toUpperCase() == 'MARKET') {

				//first order market
				if (shareData.appData.verboseLog) { Common.logger(colors.bgGreen('Calculating orders for ' + pair + '...')); }

				await delay(1000);

				let firstOrderSize = config.firstOrderAmount / askPrice;
				firstOrderSize = await filterAmount(exchange, pair, firstOrderSize);

				if (!firstOrderSize) {

					if (shareData.appData.verboseLog) { Common.logger(colors.bgRed('First order amount not valid.')); }

					return false;
				}
				else {

					totalOrderSize = firstOrderSize;
					totalAmount = config.firstOrderAmount;

					const price = await filterPrice(exchange, pair, askPrice);

					let amount = price * firstOrderSize;
					amount = await filterPrice(exchange, pair, amount);

					let targetPrice = Percentage.addPerc(
						price,
						config.dcaTakeProfitPercent
					);

					targetPrice = await filterPrice(exchange, pair, targetPrice);

					orders.push({
						orderNo: 1,
						price: price,
						average: price,
						target: targetPrice,
						qty: firstOrderSize,
						amount: amount,
						qtySum: firstOrderSize,
						sum: amount,
						type: 'MARKET',
						filled: 0
					});

					lastDcaOrderAmount = amount;
					lastDcaOrderSize = firstOrderSize;
					lastDcaOrderSum = amount;
					lastDcaOrderQtySum = firstOrderSize;
					lastDcaOrderPrice = price;
				}

				for (let i = 0; i < config.dcaMaxOrder; i++) {

					if (i == 0) {

						let price = Percentage.subPerc(
							lastDcaOrderPrice,
							config.dcaOrderStartDistance
						);

						price = await filterPrice(exchange, pair, price);

						let dcaOrderSize = config.dcaOrderAmount / price;
						dcaOrderSize = await filterAmount(exchange, pair, dcaOrderSize);

						let dcaOrderAmount = dcaOrderSize * price;
						dcaOrderAmount = await filterPrice(exchange, pair, dcaOrderAmount);

						let dcaOrderSum = parseFloat(dcaOrderAmount) + parseFloat(lastDcaOrderAmount);
						dcaOrderSum = await filterPrice(exchange, pair, dcaOrderSum);

						const dcaOrderQtySum = parseFloat(dcaOrderSize) + parseFloat(firstOrderSize);

						lastDcaOrderAmount = dcaOrderAmount;
						lastDcaOrderSize = dcaOrderSize;
						lastDcaOrderSum = dcaOrderSum;
						lastDcaOrderPrice = price;
						lastDcaOrderQtySum = dcaOrderQtySum;

						const average = await filterPrice(
							exchange,
							pair,
							parseFloat(lastDcaOrderSum) / parseFloat(lastDcaOrderQtySum)
						);

						let targetPrice = Percentage.addPerc(
							average,
							config.dcaTakeProfitPercent
						);

						targetPrice = await filterPrice(exchange, pair, targetPrice);

						orders.push({
							orderNo: i + 2,
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: dcaOrderAmount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0
						});
					}
					else {

						let price = Percentage.subPerc(
							lastDcaOrderPrice,
							(config.dcaOrderStepPercent * config.dcaOrderStepPercentMultiplier)
						);

						price = await filterPrice(exchange, pair, price);

						//let dcaOrderSize = lastDcaOrderSize * config.dcaOrderSizeMultiplier;
						let dcaOrderSize = (lastDcaOrderSize * (config.dcaOrderStepPercent / 100)) + lastDcaOrderSize * config.dcaOrderSizeMultiplier;
						dcaOrderSize = await filterAmount(exchange, pair, dcaOrderSize);

						let amount = price * dcaOrderSize;
						amount = await filterPrice(exchange, pair, amount);

						let dcaOrderSum = parseFloat(amount) + parseFloat(lastDcaOrderSum);
						dcaOrderSum = await filterPrice(exchange, pair, dcaOrderSum);

						let dcaOrderQtySum = parseFloat(dcaOrderSize) + parseFloat(lastDcaOrderQtySum);
						dcaOrderQtySum = await filterAmount(exchange, pair, dcaOrderQtySum);

						lastDcaOrderAmount = amount;
						lastDcaOrderSize = dcaOrderSize;
						lastDcaOrderSum = dcaOrderSum;
						lastDcaOrderPrice = price;
						lastDcaOrderQtySum = dcaOrderQtySum;

						const average = await filterPrice(
							exchange,
							pair,
							parseFloat(lastDcaOrderSum) / parseFloat(lastDcaOrderQtySum)
						);

						let targetPrice = Percentage.addPerc(
							average,
							config.dcaTakeProfitPercent
						);

						targetPrice = await filterPrice(exchange, pair, targetPrice);

						orders.push({
							orderNo: i + 2,
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: amount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0
						});
					}
				}

				orders.forEach(function (order) {
					t.cell('No', order.orderNo);
					t.cell('Price', '$' + order.price);
					t.cell('Average', '$' + order.average);
					t.cell('Target', '$' + order.target);
					t.cell('Qty', order.qty);
					t.cell('Amount($)', '$' + order.amount);
					t.cell('Sum(Qty)', order.qtySum);
					t.cell('Sum($)', '$' + order.sum);
					t.cell('Type', order.type);
					t.cell('Filled', order.filled == 0 ? 'Waiting' : 'Filled');
					t.newRow();
				});

				const maxDeviation = await getDeviation(Number(orders[0].price), Number(orders[orders.length - 1].price));

				//console.log(t.toString());
				//Common.logger(t.toString());

				let wallet = 0;

				if (config.sandBox) {

					wallet = config.sandBoxWallet;
				}
				else {

					const balance = await getBalance(exchange, 'USDT');
					wallet = balance;
				}

				if (config.sandBox) {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgYellow.bold('WARNING: Your bot will run in SANDBOX MODE!') ); }
				}
				else {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgRed.bold('WARNING: Your bot will run in LIVE MODE!') ); }
				}

				if (shareData.appData.verboseLog) {
					
					Common.logger(colors.bgWhite('Your Balance: $' + wallet));
					Common.logger(colors.bgWhite('Max Funds: $' + lastDcaOrderSum));
				}

				let contentAdd = '\n\n';

				if (wallet < lastDcaOrderSum) {

					contentAdd += '<b>' + insufficientFundsMsg + '</b>\n\n';

					if (shareData.appData.verboseLog) { Common.logger( colors.red.bold.italic(insufficientFundsMsg)); }
				}

				//console.log('\n');
				let sendOrders;

				if (startBot == undefined || startBot == null || startBot == false) {

					contentAdd += 'Current Balance: $' + wallet + '\n';
					contentAdd += 'Max. Funds: $' + lastDcaOrderSum + '\n';
					contentAdd += 'Max. Deviation: ' + maxDeviation.toFixed(2) + '%\n';

					return ( { 'success': true, 'data': t.toString() + contentAdd } );
/*
					sendOrders = prompt(
						colors.bgYellow('Do you want to start ' + shareData.appData.name + ' (y/n) : ')
					);

					if (sendOrders.toUpperCase() == 'Y') {

						let configStart = JSON.parse(JSON.stringify(config));

						// Set pair
						configStart.pair = pair;

						start(configStart, true);
						return;
					}
*/
				}


				if (startBot) {

					const configSave = await removeConfigData(config);

					const dealId = pair + '-' + Math.floor(Date.now() / 1000);

					dealIdMain = dealId;

					if (shareData.appData.verboseLog) { Common.logger(colors.green.bold('Please wait, ' + dealId + ' is starting... ')); }

					const deal = new Deals({
						botId: config.botId,
						botName: config.botName,
						dealId: dealId,
						exchange: config.exchange,
						pair: pair,
						date: Date.now(),
						status: 0,
						config: configSave,
						orders: orders,
						isStart: 0,
						active: true,
						dealCount: dealCount,
						dealMax: dealMax
					});

					await deal.save();

					dealTracker[dealId] = {};
					dealTracker[dealId]['deal'] = {};
					dealTracker[dealId]['info'] = {};

					dealTracker[dealId]['deal'] = JSON.parse(JSON.stringify(deal));

					let followSuccess = false;
					let followFinished = false;

					while (!followSuccess && !followFinished) {

						let followRes = await dcaFollow(config, exchange, dealId);

						followSuccess = followRes['success'];
						followFinished = followRes['finished'];

						if (!followSuccess) {

							await delay(1000);
						}
					}
				}
				else {
/*
					if (Object.keys(dealTracker).length == 0) {

						Common.logger(colors.bgRed.bold(shareData.appData.name + ' is stopping... '));
						process.exit(0);
					}
*/
				}
			}
			else {

				//first order limit

				if (shareData.appData.verboseLog) { Common.logger(colors.bgGreen('Calculating orders...')); }

				await delay(1000);

				askPrice = config.firstOrderLimitPrice;

				let firstOrderSize = config.firstOrderAmount / askPrice;
				firstOrderSize = await filterAmount(exchange, pair, firstOrderSize);

				if (!firstOrderSize) {

					if (shareData.appData.verboseLog) { Common.logger(colors.bgRed('First order amount not valid.')); }

					return false;
				}
				else {

					totalOrderSize = firstOrderSize;
					totalAmount = config.firstOrderAmount;

					const price = await filterPrice(exchange, pair, askPrice);

					let amount = price * firstOrderSize;
					amount = await filterPrice(exchange, pair, amount);

					let targetPrice = Percentage.addPerc(
						price,
						config.dcaTakeProfitPercent
					);

					targetPrice = await filterPrice(exchange, pair, targetPrice);

					orders.push({
						orderNo: 1,
						price: price,
						average: price,
						target: targetPrice,
						qty: firstOrderSize,
						amount: amount,
						qtySum: firstOrderSize,
						sum: amount,
						type: 'LIMIT',
						filled: 0
					});

					lastDcaOrderAmount = amount;
					lastDcaOrderSize = firstOrderSize;
					lastDcaOrderSum = amount;
					lastDcaOrderQtySum = firstOrderSize;
					lastDcaOrderPrice = price;
				}

				for (let i = 0; i < config.dcaMaxOrder; i++) {

					if (i == 0) {

						let price = Percentage.subPerc(
							lastDcaOrderPrice,
							config.dcaOrderStartDistance
						);

						price = await filterPrice(exchange, pair, price);

						let dcaOrderSize = config.dcaOrderAmount / price;
						dcaOrderSize = await filterAmount(exchange, pair, dcaOrderSize);

						let dcaOrderAmount = dcaOrderSize * price;
						dcaOrderAmount = await filterPrice(exchange, pair, dcaOrderAmount);

						let dcaOrderSum = parseFloat(dcaOrderAmount) + parseFloat(lastDcaOrderAmount);
						dcaOrderSum = await filterPrice(exchange, pair, dcaOrderSum);

						const dcaOrderQtySum = parseFloat(dcaOrderSize) + parseFloat(firstOrderSize);

						lastDcaOrderAmount = dcaOrderAmount;
						lastDcaOrderSize = dcaOrderSize;
						lastDcaOrderSum = dcaOrderSum;
						lastDcaOrderPrice = price;
						lastDcaOrderQtySum = dcaOrderQtySum;

						const average = await filterPrice(
							exchange,
							pair,
							parseFloat(lastDcaOrderSum) / parseFloat(lastDcaOrderQtySum)
						);

						let targetPrice = Percentage.addPerc(
							average,
							config.dcaTakeProfitPercent
						);

						targetPrice = await filterPrice(exchange, pair, targetPrice);

						orders.push({
							orderNo: i + 2,
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: dcaOrderAmount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0
						});
					}
					else {

						let price = Percentage.subPerc(
							lastDcaOrderPrice,
							(config.dcaOrderStepPercent * config.dcaOrderStepPercentMultiplier));

						price = await filterPrice(exchange, pair, price);

						let dcaOrderSize = lastDcaOrderSize * config.dcaOrderSizeMultiplier;
						dcaOrderSize = await filterAmount(exchange, pair, dcaOrderSize);

						let amount = price * dcaOrderSize;
						amount = await filterPrice(exchange, pair, amount);

						let dcaOrderSum = parseFloat(amount) + parseFloat(lastDcaOrderSum);
						dcaOrderSum = await filterPrice(exchange, pair, dcaOrderSum);

						let dcaOrderQtySum = parseFloat(dcaOrderSize) + parseFloat(lastDcaOrderQtySum);
						dcaOrderQtySum = await filterAmount(exchange, pair, dcaOrderQtySum);

						lastDcaOrderAmount = amount;
						lastDcaOrderSize = dcaOrderSize;
						lastDcaOrderSum = dcaOrderSum;
						lastDcaOrderPrice = price;
						lastDcaOrderQtySum = dcaOrderQtySum;

						const average = await filterPrice(
							exchange,
							pair,
							parseFloat(lastDcaOrderSum) / parseFloat(lastDcaOrderQtySum)
						);

						let targetPrice = Percentage.addPerc(
							average,
							config.dcaTakeProfitPercent
						);

						targetPrice = await filterPrice(exchange, pair, targetPrice);

						orders.push({
							orderNo: i + 2,
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: amount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0
						});
					}
				}

				orders.forEach(function (order) {
					t.cell('No', order.orderNo);
					t.cell('Price', '$' + order.price);
					t.cell('Average', '$' + order.average);
					t.cell('Target', '$' + order.target);
					t.cell('Qty', order.qty);
					t.cell('Amount($)', '$' + order.amount);
					t.cell('Sum(Qty)', order.qtySum);
					t.cell('Sum($)', '$' + order.sum);
					t.cell('Type', order.type);
					t.cell('Filled', order.filled == 0 ? 'Waiting' : 'Filled');
					t.newRow();
				});

				//console.log(t.toString());
				//Common.logger(t.toString());

				let wallet = 0;

				if (config.sandBox) {

					wallet = config.sandBoxWallet;
				}
				else {

					const balance = await getBalance(exchange, 'USDT');
					wallet = balance;
				}

				if (config.sandBox) {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgRed.bold('WARNING: Your bot work on SANDBOX MODE !') ); }
				}
				else {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgGreen.bold('WARNING: Your bot work on LIVE MODE !') ); }
				}

				if (shareData.appData.verboseLog) {
				
					Common.logger(colors.bgWhite('Your Balance: $' + wallet));
					Common.logger(colors.bgWhite('Max Funds: $' + lastDcaOrderSum));
				}

				if (wallet < lastDcaOrderSum) {

					if (shareData.appData.verboseLog) { Common.logger( colors.red.bold.italic(insufficientFundsMsg) ); }
				}

				let sendOrders;

				if (startBot == undefined || startBot == null || startBot == false) {

					return ( { 'success': true, 'data': t.toString() } );
/*
					sendOrders = prompt(
						colors.bgYellow('Do you want to start ' + shareData.appData.name + ' (y/n) : ')
					);

					if (sendOrders.toUpperCase() == 'Y') {

						let configStart = JSON.parse(JSON.stringify(config));

						// Set pair
						configStart.pair = pair;

						start(configStart, true);
						return;
					}
*/
				}


				if (startBot) {

					const configSave = await removeConfigData(config);

					const dealId = pair + '-' + Math.floor(Date.now() / 1000);

					dealIdMain = dealId;

					if (shareData.appData.verboseLog) { Common.logger(colors.green.bold('Please wait, ' + dealId + ' is starting... ')); }

					const deal = new Deals({
						botId: config.botId,
						botName: config.botName,
						dealId: dealId,
						exchange: config.exchange,
						pair: pair,
						date: Date.now(),
						status: 0,
						config: configSave,
						orders: orders,
						isStart: 0,
						active: true,
						dealCount: dealCount,
						dealMax: dealMax
					});

					await deal.save();

					dealTracker[dealId] = {};
					dealTracker[dealId]['deal'] = {};
					dealTracker[dealId]['info'] = {};

					dealTracker[dealId]['deal'] = JSON.parse(JSON.stringify(deal));

					let followSuccess = false;
					let followFinished = false;

					while (!followSuccess && !followFinished) {

						let followRes = await dcaFollow(config, exchange, dealId);

						followSuccess = followRes['success'];
						followFinished = followRes['finished'];

						if (!followSuccess) {

							await delay(1000);
						}
					}
				}
				else {

/*
					if (Object.keys(dealTracker).length == 0) {

						Common.logger(colors.bgRed.bold(shareData.appData.name + ' is stopping... '));

						process.exit(0);
					}
*/
				}
			}
		}
	}
	catch (e) {

		Common.logger(e);
		//console.log(e);
	}

	//console.log('Finished: ' + pair);

	try {

		const bot = await Bots.findOne({
			botId: botIdMain,
			active: false
		});

		if (bot) {

			botActive = false;
		}
	}
	catch(e) {

	}

	// Start another bot deal if max deals have not been reached
	if (botActive && (dealCount < dealMax || dealMax == 0)) {

		let configObj = JSON.parse(JSON.stringify(config));

		configObj['dealCount']++;

		if (shareData.appData.verboseLog) {

			Common.logger(colors.bgGreen('Starting new bot deal for ' + configObj.pair.toUpperCase() + ' ' + configObj['dealCount'] + ' / ' + configObj['dealMax']));
		}

		start(configObj, true, true);
	}
}


async function update(botId, data) {

	let botData;

	try {

		botData = await Bots.updateOne({
						botId: botId
					}, data);
	}
	catch (e) {

		Common.logger(JSON.stringify(e));
	}
}


const dcaFollow = async (configData, exchange, dealId) => {

	const config = Object.freeze(JSON.parse(JSON.stringify(configData)));

	let success = true;
	let finished = false;

	try {

		const deal = await Deals.findOne({
			dealId: dealId,
			status: 0
		});

		if (deal) {

			const pair = deal.pair;
			const symbolData = await getSymbol(exchange, pair);
			const symbol = symbolData.info;

			// Error getting symbol data
			if (symbolData.error != undefined && symbolData.error != null) {

				success = false;

				if (Object.keys(dealTracker).length == 0) {

					//process.exit(0);
				}

				return false;
			}

			let bidPrice = symbol.bidPrice;

			if (symbol.bidPrice == undefined || symbol.bidPrice == null) {

				bidPrice = symbol.bid;
			}

			//const price = parseFloat(symbol.bidPrice);
			const price = parseFloat(bidPrice);

			const t = new Table();
			let targetPrice = 0;

			let orders = deal.orders;

			if (deal.isStart == 0) {

				const baseOrder = deal.orders[0];
				targetPrice = baseOrder.target;

				if (baseOrder.type == 'MARKET') {
					//Send market order to exchange

					if (!config.sandBox) {

						const buy = await buyOrder(exchange, pair, baseOrder.qty);

						if (!buy) {

							Commong.logger(buy);
						}
					}

					orders[0].filled = 1;

					if (shareData.appData.verboseLog) {
					
						Common.logger(
							colors.green.bold.italic(
							'Pair:' +
							pair +
							'\tQty:' +
							baseOrder.qty +
							'\tPrice:' +
							baseOrder.price +
							'\tAmount:' +
							baseOrder.amount +
							'\tStatus:Filled'
							)
						);
					}

					orders.forEach(function (order) {
						t.cell('No', order.orderNo);
						t.cell('Price', '$' + order.price);
						t.cell('Average', '$' + order.average);
						t.cell('Target', '$' + order.target);
						t.cell('Qty', order.qty);
						t.cell('Amount($)', '$' + order.amount);
						t.cell('Sum(Qty)', order.qtySum);
						t.cell('Sum($)', '$' + order.sum);
						t.cell('Type', order.type);
						t.cell(
							'Filled',
							order.filled == 0 ? 'Waiting' : colors.bgGreen('Filled')
						);
						t.newRow();
					});

					//console.log(t.toString());
					//Common.logger(t.toString());

					await Deals.updateOne({
						dealId: dealId
					}, {
						isStart: 1,
						orders: orders
					});
				}
				else {
					//send limit order

					if (price <= baseOrder.price) {

						if (!config.sandBox) {

							const buy = await buyOrder(exchange, pair, baseOrder.qty);

							if (!buy) {

								Common.logger(buy);
							}
						}

						orders[0].filled = 1;

						if (shareData.appData.verboseLog) {
						
							Common.logger(
								colors.green.bold.italic(
								'Pair:' +
								pair +
								'\tQty:' +
								baseOrder.qty +
								'\tPrice:' +
								baseOrder.price +
								'\tAmount:' +
								baseOrder.amount +
								'\tStatus:Filled'
								)
							);
						}

						orders.forEach(function (order) {
							t.cell('No', order.orderNo);
							t.cell('Price', '$' + order.price);
							t.cell('Average', '$' + order.average);
							t.cell('Target', '$' + order.target);
							t.cell('Qty', order.qty);
							t.cell('Amount($)', '$' + order.amount);
							t.cell('Sum(Qty)', order.qtySum);
							t.cell('Sum($)', '$' + order.sum);
							t.cell('Type', order.type);
							t.cell(
								'Filled',
								order.filled == 0 ? 'Waiting' : colors.bgGreen('Filled')
							);
							t.newRow();
						});

						//console.log(t.toString());
						//Common.logger(t.toString());

						await Deals.updateOne({
							dealId: dealId
						}, {
							isStart: 1,
							orders: orders
						});
					}
					else {

						if (shareData.appData.verboseLog) {
						
							Common.logger(
								'DCA BOT will start when price react ' +
								baseOrder.price +
								', now price is ' +
								price +
								''
							);
						}

						await delay(1000);
						
						let followSuccess = false;
						let followFinished = false;

						while (!followSuccess && !followFinished) {

							let followRes = await dcaFollow(config, exchange, dealId);

							followSuccess = followRes['success'];
							followFinished = followRes['finished'];

							if (!followSuccess) {

								await delay(1000);
							}
						}
					}
				}
			}
			else {

				const filledOrders = deal.orders.filter(item => item.filled == 1);
				const currentOrder = filledOrders.pop();

				let profit = await Percentage.subNumsAsPerc(
					price,
					currentOrder.average
				);

				profit = Number(profit).toFixed(2);
				let profitPerc = profit;

				profit =
					profit > 0 ?
					colors.green.bold(profit + '%') :
					colors.red.bold(profit + '%');

				let count = 0;
				let maxSafetyOrdersUsed = false;
				let ordersFilledTotal = filledOrders.length;

				if (ordersFilledTotal >= (orders.length - 1)) {

					maxSafetyOrdersUsed = true;
				}

				for (let i = 0; i < orders.length; i++) {

					const order = orders[i];

					// Check if max safety orders used, othersie sell order condition will not be checked
					if (order.filled == 0 || maxSafetyOrdersUsed) {
					//if (order.filled == 0) {

						if (price <= parseFloat(order.price) && order.filled == 0) {
							//Buy DCA

							if (!config.sandBox) {

								const buy = await buyOrder(exchange, pair, order.qty);

								if (!buy) {

									Common.logger(buy);
								}
							}

							updateTracker(config.botName, dealId, price, currentOrder.average, currentOrder.target, profitPerc, ordersFilledTotal, orders.length, config.dealCount, config.dealMax);

							if (shareData.appData.verboseLog) {
							
								Common.logger(
									colors.blue.bold.italic(
									'Pair: ' +
									pair +
									'\tQty: ' +
									currentOrder.qtySum +
									'\tLast Price: $' +
									price +
									'\tDCA Price: $' +
									currentOrder.average +
									'\tSell Price: $' +
									currentOrder.target +
									'\tStatus:' +
									colors.green('BUY') +
									'' +
									'\tProfit: ' +
									profit +
									''
									)
								);
							}

							orders[i].filled = 1;

							await Deals.updateOne({
								dealId: dealId
							}, {
								orders: orders
							});
						}
						else if (price >= parseFloat(currentOrder.target)) {

							//Sell order

							if (deal.isStart == 1) {

								if (!config.sandBox) {

									const sell = await sellOrder(exchange, pair, order.qtySum);

									if (!sell) {

										Common.logger(sell);
									}
								}

								updateTracker(config.botName, dealId, price, currentOrder.average, currentOrder.target, profitPerc, ordersFilledTotal, orders.length, config.dealCount, config.dealMax);

								if (shareData.appData.verboseLog) {

									Common.logger(
										colors.blue.bold.italic(
										'Pair: ' +
										pair +
										'\tQty: ' +
										currentOrder.qtySum +
										'\tLast Price: $' +
										price +
										'\tDCA Price: $' +
										currentOrder.average +
										'\tSell Price: $' +
										currentOrder.target +
										'\tStatus: ' +
										colors.red('SELL') +
										'' +
										'\tProfit: ' +
										profit +
										''
										)
									);
								}

								const sellData = {
													'date': new Date(),
													'qtySum': currentOrder.qtySum,
													'price': price,
													'average': currentOrder.average,
													'target': currentOrder.target,
													'profit': profitPerc
												 };

								await Deals.updateOne({
									dealId: dealId
								}, {
									sellData: sellData,
									status: 1
								});

								delete dealTracker[dealId];

								if (shareData.appData.verboseLog) { Common.logger(colors.bgRed('Deal ID ' + dealId + ' DCA Bot Finished.')); }

								success = true;
								finished = true;

								return ( { 'success': success, 'finished': finished } );
							}
						}
						else {

							updateTracker(config.botName, dealId, price, currentOrder.average, currentOrder.target, profitPerc, ordersFilledTotal, orders.length, config.dealCount, config.dealMax);

							if (shareData.appData.verboseLog) {
							
								Common.logger(
								'Pair: ' +
								pair +
								'\tLast Price: $' +
								price +
								'\tDCA Price: $' +
								currentOrder.average +
								'\t\tTarget: $' +
								currentOrder.target +
								'\t\tNext Order: $' +
								order.price +
								'\tProfit: ' +
								profit +
								''
								);
							}
						}

						await delay(2000);
						count++;

						break;
					}
				}

				//if (ordersFilledTotal >= config.dcaMaxOrder) {
				if (maxSafetyOrdersUsed) {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgYellow.bold(pair + ' Max safety orders used.') + '\tLast Price: $' + price + '\tTarget: $' + currentOrder.target + '\tProfit: ' + profit); }
					
					//await delay(2000);
				}

			}

			let followSuccess = false;
			let followFinished = false;

			while (!followSuccess && !followFinished) {

				let followRes = await dcaFollow(config, exchange, dealId);

				followSuccess = followRes['success'];
				followFinished = followRes['finished'];

				if (!followSuccess) {

					await delay(1000);
				}
			}
		}
		else {

			if (!followFinished) {

				if (shareData.appData.verboseLog) { Common.logger('No deal ID found for ' + config.pair); }
			}
		}
	}
	catch (e) {

		success = false;

		Common.logger(JSON.stringify(e));
	}

	return ( { 'success': success, 'finished': finished } );
};


const getSymbolsAll = async (exchange) => {

	const markets = await exchange.loadMarkets();
	const symbols = exchange.symbols;

	return symbols;
}


const getSymbol = async (exchange, pair) => {

	let symbolInfo;
	let symbolError;

	let symbolInvalid = false;

	try {

		const symbol = await exchange.fetchTicker(pair);
		symbolInfo = symbol.info;
	}
	catch (e) {

		symbolError = e;

		if (e instanceof ccxt.BadSymbol) {

			symbolInvalid = true;
		}

		Common.logger(colors.bgRed.bold.italic('Get symbol ' + pair + ' error: ' + JSON.stringify(e)));
	}

	return ( { 'info': symbolInfo, 'invalid': symbolInvalid, 'error': symbolError } );
};


const filterAmount = async (exchange, pair, amount) => {

	try {

		return exchange.amountToPrecision(pair, amount);
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

		return false;
	}
};


const filterPrice = async (exchange, pair, price) => {

	try {

		return exchange.priceToPrecision(pair, price);
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

		return false;
	}
};


const checkActiveDeal = async (pair) => {

	try {

		const deal = await Deals.findOne({
			pair: pair,
			status: 0
		});

		return deal;
	}
	catch (e) {

		Common.logger(JSON.stringify(e));
	}
};


const getDeals = async (query) => {
	
	if (query == undefined || query == null) {

		query = {};
	}


	try {

		const deals = await Deals.find(query);

		return deals;
	}
	catch (e) {

		Common.logger(JSON.stringify(e));
	}
};

		
const getBalance = async (exchange, symbol) => {

	try {

		let balance = await exchange.fetchBalance();
		balance = balance[symbol].free;

		return parseFloat(balance);
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

		return false;
	}
};


const buyOrder = async (exchange, pair, qty) => {

	try {

		const order = await exchange.createMarketBuyOrder(pair, qty, null);
		return true;
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

		return 'Error : ' + e.message;
	}
};


const sellOrder = async (exchange, pair, qty) => {

	try {

		const order = await exchange.createMarketSellOrder(pair, qty, null);
		return true;
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

		return 'Error : ' + e.message;
	}
};


const getDeviation = async (a, b) => {

	return (Math.abs( (a - b) / ( (a + b) / 2 ) ) * 100);
}


async function checkTracker() {

	// Monitor existing deals if they weren't updated after n minutes to take potential action
	const maxMins = 3;

	for (let dealId in dealTracker) {

		let deal = dealTracker[dealId]['info'];

		let diffSec = (new Date().getTime() - new Date(deal['updated']).getTime()) / 1000;

		if (diffSec > (60 * maxMins)) {

			diffSec = (diffSec / 60).toFixed(2);

			Common.logger('WARNING: ' + dealId + ' exceeds last updated time by ' + diffSec + ' minutes');
		}
	}
}


async function updateTracker(botName, dealId, priceLast, priceAverage, priceTarget, takeProfitPerc, ordersUsed, ordersMax, dealCount, dealMax) {

	const dealObj = {
						'updated': new Date(),
						'bot_name': botName,
						'safety_orders_used': ordersUsed,
						'safety_orders_max': ordersMax - 1,
						'price_last': priceLast,
						'price_average': priceAverage,
						'price_target': priceTarget,
						'take_profit_percentage': takeProfitPerc,
						'deal_count': dealCount,
						'deal_max': dealMax
					};

	dealTracker[dealId]['info'] = dealObj;
}


async function initBot(config) {

	let configObj = JSON.parse(JSON.stringify(config));
	let configSave = await removeConfigData(JSON.parse(JSON.stringify(config)));

	configObj = await setConfigData(configObj);

	try {

		const bot = await Bots.findOne({
			botId: configObj.botId,
		});

		if (!bot) {

			const bot = new Bots({
						
							botId: configObj.botId,
							botName: configObj.botName,
							config: configSave,
							active: true,
							date: Date.now(),
						});

			await bot.save();
		}
	}
	catch (e) {

		//console.log(e);
	}

	return configObj;
}


async function setConfigData(config) {

	let configObj = JSON.parse(JSON.stringify(config));

	const botConfig = await shareData.Common.getConfig('bot.json');

	for (let key in botConfig.data) {

		if (key.substring(0, 3).toLowerCase() == 'api') {

			configObj[key] = botConfig.data[key];
		}
	}

	// Set bot id
	if (configObj['botId'] == undefined || configObj['botId'] == null || configObj['botId'] == '') {

		configObj['botId'] = uuidv4();
	}

	// Set initial deal count
	if (configObj['dealCount'] == undefined || configObj['dealCount'] == null || configObj['dealCount'] == 0) {

		configObj['dealCount'] = 1;
	}

	return configObj;
}


async function removeConfigData(config) {

	let configObj = JSON.parse(JSON.stringify(config));

	for (let key in configObj) {

		if (key.substring(0, 3).toLowerCase() == 'api') {

			delete configObj[key];
		}
	}

	return configObj;
}


async function getDealsHistory() {

	let dealsArr = [];

	const dealsHistory = await getDeals({ 'sellData': { $exists: true }, 'status': 1 });

	if (dealsHistory != undefined && dealsHistory != null && dealsHistory != '') {

		for (let i = 0; i < dealsHistory.length; i++) {

			const deal = dealsHistory[i];
			const sellData = deal.sellData;
			const orders = deal.orders;

			let orderCount = 0;

			for (let x = 0; x < orders.length; x++) {

				const order = orders[x];

				if (order['filled']) {

					orderCount++;
				}
			}

			if (orderCount > 0 && (sellData.date != undefined && sellData.date != null)) {

				const profitPerc = Number(sellData.profit);

				const profit = Number((Number(orders[orderCount - 1]['sum']) * (profitPerc / 100)).toFixed(2));

				const dataObj = {
									'deal_id': deal.dealId,
									'pair': deal.pair.toUpperCase(),
									'date_start': new Date(deal.date),
									'date_end': new Date(sellData.date),
									'profit': profit,
									'profit_percent': profitPerc,
									'safety_orders': orderCount - 1
								};

				dealsArr.push(dataObj);
			}
		}
	}

	dealsArr = Common.sortByKey(dealsArr, 'date_end');

	return dealsArr.reverse();
}


async function resumeBots() {

	// Check for active deals and resume bots
	// New logic needed to find bots that have not reached max deals and are currently not running an active deal

	const dealsActive = await getDeals({ 'status': 0 });

	if (dealsActive.length > 0) {

		Common.logger( colors.bgBrightYellow.bold('Resuming ' + dealsActive.length + ' active DCA bot deals...') );

		for (let i = 0; i < dealsActive.length; i++) {

			let deal = dealsActive[i];

			const botId = deal.botId;
			const botName = deal.botName;
			const dealId = deal.dealId;
			const pair = deal.pair;
			const dealCount = deal.dealCount;
			const dealMax = deal.dealMax;

			// Set previous deal counts
			let config = deal.config;

			config['botId'] = botId;
			config['botName'] = botName;
			config['dealCount'] = dealCount;
			config['dealMax'] = dealMax;

			deal['config'] = config;

			dealTracker[dealId] = {};
			dealTracker[dealId]['info'] = {};

			dealTracker[dealId]['deal'] = JSON.parse(JSON.stringify(deal));

			start(config, true, true);

			await delay(1000);
		}
	}
}


async function initApp() {

	setInterval(() => {

		checkTracker();

	}, (60000 * 1));

	resumeBots();
}


module.exports = {

	colors,
	delay,
	start,
	update,
	getDealsHistory,

	init: function(obj) {

		shareData = obj;

		shareData['dealTracker'] = dealTracker;

		initApp();
    }
}
