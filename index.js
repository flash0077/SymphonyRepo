var request = require('request')
var Q = require('q')
var lodash = require('lodash')
var utility = require('ptc-symphony-sdk').utility
var customFilters = require('ptc-symphony-sdk').CustomFilters
var baseURL = 'https://slack.com/api/'

var Trigger = {
  name: 'slack',
  title: 'Slack'
}

module.exports = Trigger

Trigger.execute = execute
Trigger.validate = validate
Trigger.activate = activate

function activate (input, options, output) {
  var cursor = options.meta.cursor
  validateSlackRestEndpoints(input, options, output, cursor)
}

function validate (input, options, output) {
  let cursor = Math.floor(Date.now() / 1000)
  validateSlackRestEndpoints(input, options, output, cursor)
}

function validateSlackRestEndpoints (input, options, output, cursor) {
  let url
  switch (input.event) {
    case 'new_public_channel':
      url = baseURL + 'channels.list'
      break
    case 'new_private_channel':
      url = baseURL + 'groups.list'
      break
    case 'new_public_message':
      url = baseURL + 'channels.history?channel=' + input.channelID + '&oldest=' + cursor
      break
    case 'new_private_message':
      url = baseURL + 'groups.history?channel=' + input.channelID + '&oldest=' + cursor
      break
  }
  request({
    method: 'GET',
    url: url,
    qs: {
      token: input.auth
    }
  }, function (err, res, body) {
    if (err || res.statusCode !== 200) {
      return output('Enter valid Authentication details!!')
    }
    if (typeof body === 'string') {
      body = JSON.parse(body)
    }

    switch (input.event) {
      case 'new_public_channel':
        cursor = lastRecordTime(body.channels)
        break
      case 'new_private_channel':
        cursor = lastRecordTime(body.groups)
        break
      default:
        if (body && body.messages && body.messages.length) {
          cursor = body.messages[0].ts
        }
        break
    }
    options.setMeta({
      cursor: (cursor || Math.floor(Date.now() / 1000))
    })
    output(null, true)
  })
}

function execute (input, options, output) {
  run(input, options, function (err, data) {
    if (err || !data) {
      return output(err || 'empty')
    }
    return customFilters.filter(input.customFilters, data, output)
  })
}

function run (input, options, output) {
  var url
  var oldest = options.meta.cursor
  switch (input.event) {
    case 'new_public_channel':
      url = baseURL + 'channels.list'
      break
    case 'new_private_channel':
      url = baseURL + 'groups.list'
      break
    case 'new_public_message':
      url = baseURL + 'channels.history?channel=' + input.channelID + '&oldest=' + oldest
      break
    case 'new_private_message':
      url = baseURL + 'groups.history?channel=' + input.channelID + '&oldest=' + oldest
      break
  }

  request({
    method: 'GET',
    url: url,
    qs: {
      token: input.auth
    }
  }, function (err, res, body) {
    if (err) {
      return output(err)
    }
    if (!res || !res.statusCode || res.statusCode !== 200) {
      return output(body)
    }
    if (typeof (body) === 'string') {
      body = JSON.parse(body)
    }
    if (body) {
      switch (input.event) {
        case 'new_public_channel':
          return findNewChannel(input, options, body.channels, output)
        case 'new_private_channel':
          return findNewChannel(input, options, body.groups, output)
        case 'new_public_message':
          return findNewMessage(input, options, body.messages, output)
        case 'new_private_message':
          return findNewMessage(input, options, body.messages, output)
      }
    }
    output(null, [])
  })
}

function findNewChannel (input, options, channels, callback) {
  if (!channels || !channels.length) {
    return callback(null, [])
  }
  var cursor = options.meta.cursor
  var filteredData = channels.filter(function (item) {
    if (item.created > cursor) {
      return true
    }
  })

  if (!filteredData.length) {
    return callback(null, [])
  }

  if (input.event === 'new_private_channel') {
    filteredData = filteredData.map(function (channel) {
      channel.num_members = channel.members.length
      return channel
    })
  }

  var lastSync = lastRecordTime(filteredData)
  options.setMeta({
    cursor: lastSync
  })

  getFormattedResponse(input, filteredData, function (err, data) {
    if (data && data.length) {
      return callback(null, data)
    }
    return callback(null, [])
  })

  // callback(null, filteredData);
  filteredData = null
}

function findNewMessage (input, options, messages, callback) {
  if (!messages || !messages.length) {
    return callback(null, [])
  }
  options.setMeta({
    cursor: messages[0].ts
  })

  getFormattedResponse(input, messages, function (err, data) {
    if (data && data.length) {
      return callback(null, data)
    }
    return callback(null, [])
  })

  // callback(null, messages);
}

function lastRecordTime (body) {
  var lastSync
  lastSync = body.reduce(function (previousValue, currentValue) {
    var preValue = previousValue
    if (previousValue && previousValue.created) {
      preValue = previousValue.created
    }
    var curValue = currentValue.created
    if (preValue > curValue) {
      return preValue
    }
    return curValue
  })
  if (lastSync && typeof lastSync === 'object') {
    return lastSync.created
  }
  return lastSync
}

function getFormattedResponse (input, data, cb) {
  var propmises = data.map(function (prop) {
    var deferred = Q.defer()
    var url = baseURL + 'users.info'
    // for messages sent from bots the username is already populated. otherwise user id is in the response.
    if(prop.username) {
      return deferred.resolve(prop)
    }
    var user = prop.creator
    if (prop.user) {
      user = prop.user
    }
    var qs = {
      token: input.auth,
      user: user
    }
    _request(url, qs, function (err, item) {
      if (err) {
        return deferred.reject(err)
      }
      if (typeof item === 'string') {
        item = JSON.parse(item)
      }
      prop.username = item.user.name
      deferred.resolve(prop)
    })
    return deferred.promise
  })

  Q.allSettled(propmises)
    .then(function (result) {
      var final = result.map(function (prop) {
        if (prop.state === 'fulfilled') { return prop.value }
      })
      final = lodash.pull(final, undefined)
      if (final.length) {
        return cb(null, final)
      }
      return cb(null, [])
    })
}

function _request (url, qs, cb) {
  request({
    url: url,
    qs: qs
  }, function (e, r, b) {
    if (e) {
      return cb(e)
    }
    return cb(null, b)
  })
}
