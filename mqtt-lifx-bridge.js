// Requirements
const mqtt = require('mqtt')
const logging = require('homeautomation-js-lib/logging.js')
const _ = require('lodash')
const health = require('homeautomation-js-lib/health.js')
const Lifx  = require('node-lifx-lan')
const mqtt_helpers = require('homeautomation-js-lib/mqtt_helpers.js')
const repeat = require('repeat')

// Config
var topicPrefix = process.env.TOPIC_PREFIX

if (_.isNil(topicPrefix)) {
	topicPrefix = 'lifx'
}

var mqttOptions = {qos: 1}

var shouldRetain = process.env.MQTT_RETAIN

if (_.isNil(shouldRetain)) {
	shouldRetain = true
}

if (!_.isNil(shouldRetain)) {
	mqttOptions['retain'] = shouldRetain
}

var connectedEvent = function() {
	logging.info('MQTT Connected')
	client.subscribe(topicPrefix + '/+/+/+/setPower', {qos: 1})
	health.healthyEvent()
}

var disconnectedEvent = function() {
	logging.error('Reconnecting...')
	health.unhealthyEvent()
}

// Setup MQTT
var client = mqtt.setupClient(connectedEvent, disconnectedEvent)


var deviceIPMap = {}
var deviceMACMap = {}
var deviceGroupMap = {}
var deviceLocationMap = {}
var deviceNameMap = {}

const registerDevice = function(topic, location, group, name, ip, mac) {
	logging.debug('registering ip: ' + ip + '   mac: ' + mac)
	
	deviceIPMap[topic] = ip
	deviceMACMap[topic] = mac
	deviceGroupMap[topic] = group
	deviceLocationMap[topic] = location
	deviceNameMap[topic] = name
}

const allRegisteredTopics = function() {	
	return Object.keys(deviceIPMap)
}

const lookupRegisteredDevice = function(topic, callback) {
	if ( _.isNil(topic) ) {
		return null
	}

	logging.debug('looking up ip: ' + deviceIPMap[topic] + '   mac: ' + deviceMACMap[topic])

	Lifx.createDevice({
		mac: deviceMACMap[topic],
		ip: deviceIPMap[topic]
	}).then((device) => {
		return device
	}).then((device) => {
		callback(device)
	}).catch((error) => {
		logging.error('could not create device: ' + error)
		callback(null)
	})  
}

const processDeviceState = function(location, group, name, powerState) {
	const topic = mqtt_helpers.generateTopic(topicPrefix, location, group, name)
	
	logging.info(' powerState: ' + powerState)
	logging.info('       name: ' + name)
	logging.info('      group: ' + group)
	logging.info('   location: ' + location)
	logging.info('      topic: ' + topic)

	client.smartPublish(topic, powerState.toString(), mqttOptions)
}

const processDeviceUpdate = function(device) {
	Promise.all([device.lightGetPower()]).then(values => {
		const ip = device['ip']
		const mac = device['mac']
		const powerState = values['0']['level']
		const deviceInfo = device['deviceInfo']
		const name = deviceInfo['label']
		const location = deviceInfo['location']['label']
		const group = deviceInfo['group']['label']	
		const topic = mqtt_helpers.generateTopic(topicPrefix, location, group, name)

		logging.info('     device: ' + JSON.stringify(deviceInfo))
		logging.info('         ip: ' + ip)
		logging.info('     values: ' + JSON.stringify(values))

		registerDevice(topic, ip, mac)
		processDeviceState(location, group, name, powerState)
	})
}

const discoverDevices = function() {
	Lifx.discover({wait: 10000}).then((device_list) => {
		var allTopics = allRegisteredTopics()
		logging.info('starting all items: ' + JSON.stringify(allTopics))

		device_list.forEach(device => {
			const deviceInfo = device['deviceInfo']
			const name = deviceInfo['label']
			const location = deviceInfo['location']['label']
			const group = deviceInfo['group']['label']	
			const topic = mqtt_helpers.generateTopic(topicPrefix, location, group, name)

			processDeviceUpdate(device)

			const index = allTopics.indexOf(topic)
			if (index > -1) {
				allTopics.splice(index, 1)
			}
		})

		logging.info('remaining items: ' + JSON.stringify(allTopics))
		allTopics.forEach(missingTopic => {
			client.smartPublish(missingTopic, '0', mqttOptions)
		})

		return true
	}).then(() => {
		logging.info('Done discovery/poll')
	}).catch((error) => {
		logging.error('discover error: ' + error)
	})
}

const lowerCaseCompare = function(objValue, othValue) {
	if (mqtt_helpers.generateTopic(objValue) == mqtt_helpers.generateTopic(othValue)) {
		return true
	}

	return false
}
  
const findDevice = function(location, group, label, callback) {
	lookupRegisteredDevice(mqtt_helpers.generateTopic(topicPrefix, location, group, label), function(registeredDevice) {
		if ( _.isNil(registeredDevice) ) {
			Lifx.discover().then((device_list) => {
				var foundDevice = null
	
				device_list.forEach(device => {
					const deviceInfo = device['deviceInfo']
					const thisName = deviceInfo['label']
					const thisLocation = deviceInfo['location']['label']
					const thisGroup = deviceInfo['group']['label']
	
					if (        _.isEqualWith(thisName, label, lowerCaseCompare) 
						&&  _.isEqualWith(thisLocation, location, lowerCaseCompare)
						&&  _.isEqualWith(thisGroup, group, lowerCaseCompare) ) {
						foundDevice = device
					}
				})
	
				return foundDevice
			}).then((result) => {
				callback(result)
			}).catch((error) => {
				console.error(error)
				callback(null)
			})
		} else {
			return callback(registeredDevice)
		}
	})
}

client.on('message', (topic, message) => {
	var components = topic.split('/')
    
	const location = components[components.length - 4]
	const group = components[components.length - 3]
	const label = components[components.length - 2]

	findDevice(location, group, label, function(foundDevice) {
		if ( foundDevice ) {
			if ( topic.endsWith('/setPower') ) {
				if ( message == '1' ) {
					foundDevice.turnOn()
				} else {
					foundDevice.turnOff()
				}
			} else {
				logging.error('Unknown command: ' + _.last(components))
			}
		} else {
			logging.error('Could not find device:')
			logging.info('         label: ' + label)
			logging.info('         group: ' + group)
			logging.info('      location: ' + location)
		}
	})
})


repeat(discoverDevices).every(30, 's').start.in(2, 'sec')
