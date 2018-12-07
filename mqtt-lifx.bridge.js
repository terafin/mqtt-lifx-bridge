// Requirements
const mqtt = require('mqtt')
const logging = require('homeautomation-js-lib/logging.js')
const _ = require('lodash')
const health = require('homeautomation-js-lib/health.js')

const Lifx  = require('node-lifx-lan')

const mqtt_helpers = require('homeautomation-js-lib/mqtt_helpers.js')


// Config
var topicPrefix = process.env.TOPIC_PREFIX

if (_.isNil(topicPrefix)) {
    topicPrefix = 'lifx'
}

var mqttOptions = {qos: 2}

var shouldRetain = process.env.MQTT_RETAIN

if (_.isNil(shouldRetain)) {
	shouldRetain = true
}

if (!_.isNil(shouldRetain)) {
	mqttOptions['retain'] = shouldRetain
}

var connectedEvent = function() {
	logging.info('MQTT Connected')
	client.subscribe(topicPrefix + '/#/#/#/#', {qos: 2})
	health.healthyEvent()
}

var disconnectedEvent = function() {
	logging.error('Reconnecting...')
	health.unhealthyEvent()
}

// Setup MQTT
var client = mqtt.setupClient(connectedEvent, disconnectedEvent)

var processAction = function(shouldRetain, value, topic, callback) {
	if (!_.isNil(value) && !_.isNil(topic)) {
		client.publish(topic, '' + value, {retain: shouldRetain})
		logging.info('alexa action' + JSON.stringify({'action': 'alexa-request', 'topic': topic, 'value': value}))
	}

	if (!_.isNil(callback)) {
		return callback() 
	}

	return true
}


const processDeviceUpdate = function(device) {
    Promise.all([device.lightGetPower()]).then(values => {
        const powerState = values[0]
        const deviceInfo = device['deviceInfo']
        const name = deviceInfo['label']
        const location = deviceInfo['location']['label']
        const group = deviceInfo['group']['label']
        const topic = mqtt_helpers(topicPrefix, location, group, name)
        
        logging.info('     device: ' + JSON.stringify(deviceInfo))
        logging.info(' powerState: ' + JSON.powerState)
        logging.info('      group: ' + group)
        logging.info('      topic: ' + topic)

        client.publish(topic, powerState.toString(), mqttOptions)
    })
}

const discoverDevices = function() {
    // Discover LIFX bulbs in the local network
    Lifx.discover().then((device_list) => {
        // Turn on LIFX bulbs whose group is `Room 1` in blue
        device_list.forEach(device => {
            processDeviceUpdate(device)
        })
    }).then(() => {
        console.log('Done discovery/poll')
    }).catch((error) => {
        console.error(error)
    })
}

const lowerCaseCompare = function(objValue, othValue) {
    if (_.toLower(objValue) == _.toLower(othValue)) {
      return true
    }

    return false
}
  
const findDevice = function(location, group, label, callback) {
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

}

client.on('message', (topic, message) => {
	var components = topic.split('/')
	var refID = null
    var type = null
    
    const location = components[components.length - 5]
    const group = components[components.length - 4]
    const label = components[components.length - 3]

    const foundDevice = findDevice(location, group, label)

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