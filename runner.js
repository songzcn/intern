/*jshint node:true */
if (typeof process !== 'undefined' && typeof define === 'undefined') {
	var req = require('./dojo/dojo');
	req({
		baseUrl: __dirname + '/../',
		packages: [
			{ name: 'dojo-ts', location: __dirname + '/dojo' },
			{ name: 'teststack', location: __dirname }
		]
	}, [ 'teststack/runner' ]);
}
else {
	define([
		'require',
		'./main',
		'./lib/createProxy',
		'dojo-ts/node!istanbul/lib/instrumenter',
		'dojo-ts/node!sauce-connect-launcher',
		'./lib/args',
		'./lib/util',
		'./lib/Suite',
		'./lib/Test',
		'./lib/wd',
		'dojo-ts/io-query',
		'dojo-ts/Deferred',
		'dojo-ts/topic',
		'./lib/EnvironmentType'
	], function (require, main, createProxy, Instrumenter, startConnect, args, util, Suite, Test, wd, ioQuery, Deferred, topic, EnvironmentType) {
		if (!args.config) {
			throw new Error('Required option "config" not specified');
		}

		if (!args.reporter) {
			console.info('Defaulting to "runner" reporter');
			args.reporter = 'runner';
		}

		args.reporter = args.reporter.indexOf('/') > -1 ? args.reporter : './lib/reporters/' + args.reporter;

		require([ args.config, args.reporter ], function (config) {
			createProxy(config.proxyPort, new Instrumenter({
				// coverage variable is changed primarily to avoid any jshint complaints, but also to make it clearer
				// where the global is coming from
				coverageVariable: '__teststackCoverage',

				// compacting code makes it harder to look at but it does not really matter
				noCompact: true,

				// auto-wrap breaks code
				noAutoWrap: true
			}), '..');

			// Running just the proxy and aborting is useful mostly for debugging, but also lets you get code coverage
			// reporting on the client if you want
			if (args.proxyOnly) {
				return;
			}

			// TODO: Verify that upon using delete, it is not possible for the program to retrieve these environment
			// variables another way.
			if (process.env.SAUCE_USERNAME) {
				config.webdriver.username = process.env.SAUCE_USERNAME;
				if (!(delete process.env.SAUCE_USERNAME)) {
					throw new Error('Failed to clear sensitive environment variable SAUCE_USERNAME');
				}
			}
			if (process.env.SAUCE_ACCESS_KEY) {
				config.webdriver.accessKey = process.env.SAUCE_ACCESS_KEY;
				if (!(delete process.env.SAUCE_ACCESS_KEY)) {
					throw new Error('Failed to clear sensitive environment variable SAUCE_ACCESS_KEY');
				}
			}

			// TODO: Global require is needed because context require does not currently have config mechanics built
			// in.
			config.packages && this.require({ packages: config.packages });

			var startup;
			if (config.useSauceConnect) {
				if (!config.webdriver.username || !config.webdriver.accessKey) {
					throw new Error('Missing Sauce username or access key. Disable Sauce Connect or provide this information.');
				}

				startup = util.adapt(startConnect);
			}
			else {
				startup = function () {
					return {
						then: function (callback) {
							callback();
						}
					};
				};
			}

			main.maxConcurrency = config.maxConcurrency || Infinity;
			util.flattenEnvironments(config.environments).forEach(function (environmentType) {
				var suite = new Suite({
					name: 'main',
					remote: wd.remote(config.webdriver, environmentType),
					setup: function () {
						var remote = this.remote;
						return remote.init()
						.then(function getEnvironmentInfo(sessionId) {
							// wd incorrectly puts the session ID on a sessionID property
							remote.sessionId = sessionId;
						})
						.sessionCapabilities()
						.then(function (capabilities) {
							remote.environmentType = new EnvironmentType(capabilities);
							topic.publish('/session/start', remote);
						});
					},

					teardown: function () {
						var remote = this.remote;
						return remote.quit().always(function () {
							topic.publish('/session/end', remote);
						});
					}
				});

				// TODO: Just create some RemoteTest type instead that does this stuff?
				// TODO: Seems timeouts are busted~
				suite.tests.push(new Test({ name: 'client', timeout: 10 * 60 * 1000, parent: suite, test: function () {
					var remote = this.remote,
						options = {
							sessionId: remote.sessionId,
							reporter: 'webdriver',
							suites: config.suites
						};

					if (config.packages) {
						options.packages = JSON.stringify(config.packages);
					}

					console.log('Running automated test suite for ' + remote.environmentType);
					return remote.get(config.clientHtmlLocation + '?' + ioQuery.objectToQuery(options)).then(function waitForSuiteToFinish() {
						var dfd = new Deferred();

						// TODO: And if it doesn't finish..?
						var handle = topic.subscribe('/client/end', function (sessionId) {
							if (sessionId === remote.sessionId) {
								console.log('Automated test suite complete for ' + remote.environmentType + ', starting functional tests');
								handle.remove();
								dfd.resolve();
							}
						});

						return dfd.promise;
					});
				}}));

				main.suites.push(suite);
			});

			startup({
				logger: function () {
					console.log.apply(console, arguments);
				},
				username: config.webdriver.username,
				accessKey: config.webdriver.accessKey,
				port: config.webdriver.port
			}).then(function () {
				require(config.functionalSuites, function () {
					var hasErrors = false;

					topic.subscribe('/error, /test/fail', function () {
						hasErrors = true;
					});

					topic.publish('/runner/start');
					main.run().always(function () {
						topic.publish('/runner/end');
						process.exit(hasErrors ? 1 : 0);
					});
				});
			}, function (error) {
				console.error(error);
				process.exit(1);
			});
		});
	});
}