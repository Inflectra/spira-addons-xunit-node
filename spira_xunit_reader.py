import requests
import re
import json
import datetime
import time
import configparser
import xml.etree.ElementTree as ET
import sys
import base64
import os

'''
The config is only retrieved once
'''
config = None

def getConfig(config_file):
    global config
    # Only retrieve config once
    if config is None:
        # Model of config object:
        config = {
            "url": "",
            "username": "",
            "token": "",
            "project_id": -1,
            "release_id": -1,
            "test_set_id": -1,
            "create_build": False,
            "test_case_ids": {},
            "test_set_ids": {}
        }
        # Parse the config file
        parser = configparser.ConfigParser()
        parser.read(config_file)

        sections = parser.sections()

        # Process Configs
        for section in sections:
            # Handle credentials and test case / test set mappings differently
            if section == "credentials":
                for (key, value) in parser.items(section):
                    if key == 'create_build':
                        config[key] = bool(value)
                    else:
                        config[key] = value
            elif section == "test_cases":
                for (key, value) in parser.items(section):
                    # print("Config: added key='{}', value='{}'".format(key.lower(), value))
                    config["test_case_ids"][key.lower()] = value
            elif section == "test_sets":
                for (key, value) in parser.items(section):
                    # print("Config: added key='{}', value='{}'".format(key.lower(), value))
                    config["test_set_ids"][key.lower()] = int(value)
    return config


# Name of this extension
RUNNER_NAME = "xUnit (Python)"

class SpiraDocument:
    # The URL snippet used after the Spira URL
    REST_SERVICE_URL = "/Services/v6_0/RestService.svc/"
    # The URL spippet used to post a new file or URL attachment linked to a test run
    POST_DOCUMENT_FILE = "projects/{}/documents/file"
    POST_DOCUMENT_URL = "projects/{}/documents/url"

    '''
    A Document object model for Spira
    '''
    project_id = -1
    attachment_type_id = -1
    test_run_id = -1
    filename_or_url = ""
    version_name = ""

    def __init__(self, project_id, attachment_type_id, test_run_id, filename_or_url, version_name):
        self.project_id = project_id
        self.attachment_type_id = attachment_type_id
        self.test_run_id = test_run_id
        self.filename_or_url = filename_or_url
        self.version_name = version_name

    def post(self, spira_url, spira_username, spira_token, binary_data=None):
        """
        Create a new attachment in Spira with the given credentials for associating the test runs with
        """
        # Default to URL attachment
        url = spira_url + self.REST_SERVICE_URL + self.POST_DOCUMENT_URL.format(self.project_id)
        if self.attachment_type_id == 1 and binary_data is not None:
            # We have a file attachment
            url = spira_url + self.REST_SERVICE_URL + self.POST_DOCUMENT_FILE.format(self.project_id)

        # The credentials we need
        params = {
            'username': spira_username,
            'api-key': spira_token
        }

        # The headers we are sending to the server
        headers = {
            'accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': RUNNER_NAME
        }

        # The body we are sending
        body = {
            'ProjectId': self.project_id,
            'AttachmentTypeId': self.attachment_type_id,
            'FilenameOrUrl': self.filename_or_url,
            'CurrentVersion': self.version_name,
            'AttachedArtifacts': [{
                'ArtifactId': self.test_run_id,
                'ArtifactTypeId': 5 # Test Run
            }]
        }

        # Add the binary data if appropriate
        if self.attachment_type_id == 1:
            body['BinaryData'] = binary_data

        dumps = json.dumps(body)
        # print (dumps)

        response = requests.post(url, data=json.dumps(body), params=params, headers=headers)

        if response.status_code == 404:
            # Test Case Not Found
            print ("Unable to find a matching Spira test run of id TR:{}, so not able to post result".format(self.test_run_id))
            return None
        elif response.status_code == 200:
            # OK
            document = response.json()
            return document['AttachmentId']
        else:
            # General Error
            print ("Unable to create document due to HTTP error: {} ({})".format(response.reason, response.status_code))
            return None
        

class SpiraBuild:
    # The URL snippet used after the Spira URL
    REST_SERVICE_URL = "/Services/v6_0/RestService.svc/"
    # The URL spippet used to post a build. Needs the project ID and release ID to work
    POST_BUILD = "projects/{}/releases/{}/builds"

    '''
    A Build object model for Spira
    '''
    project_id = -1
    release_id = -1
    build_status_id = -1
    name = ""
    description = ""

    def __init__(self, project_id, release_id, build_status_id, name, description=""):
        self.project_id = project_id
        self.release_id = release_id
        self.name = name
        self.build_status_id = build_status_id
        self.description = description

    def post(self, spira_url, spira_username, spira_token):
        """
        Create a new build in Spira with the given credentials for associating the test runs with
        """
        url = spira_url + self.REST_SERVICE_URL + \
            (self.POST_BUILD.format(self.project_id, self.release_id))
        # The credentials we need
        params = {
            'username': spira_username,
            'api-key': spira_token
        }

        # The headers we are sending to the server
        headers = {
            'accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': RUNNER_NAME
        }

        # The body we are sending
        body = {
            # 1=Failed, 2=Passed
            'ProjectId': self.project_id,
            'BuildStatusId': self.build_status_id,
            'ReleaseId': self.release_id,
            'Name': self.name,
            'Description': self.description            
        }

        dumps = json.dumps(body)
        # print (dumps)

        response = requests.post(url, data=json.dumps(
            body), params=params, headers=headers)

        if response.status_code == 404:
            # Test Case Not Found
            print ("Unable to find a matching Spira release of id RL:{}, so not able to post result".format(self.release_id))
            return None
        elif response.status_code == 200:
            # OK
            build = response.json()
            return build['BuildId']
        else:
            # General Error
            print ("Unable to create build due to HTTP error: {} ({})".format(response.reason, response.status_code))
            return None


class SpiraTestRun:
    # The URL snippet used after the Spira URL
    REST_SERVICE_URL = "/Services/v6_0/RestService.svc/"
    # The URL spippet used to post an automated test run. Needs the project ID to work
    POST_TEST_RUN = "projects/%s/test-runs/record"
    '''
    A TestRun object model for Spira
    '''
    project_id = -1
    test_case_id = -1
    test_name = ""
    stack_trace = ""
    status_id = -1
    start_time = -1
    end_time = -1
    message = ""
    release_id = -1
    test_set_id = -1
    build_id = -1

    def __init__(self, project_id, test_case_id, test_name, stack_trace, status_id, start_time, end_time, message='', release_id=-1, test_set_id=-1, assert_count=0, build_id=-1):
        self.project_id = project_id
        self.test_case_id = test_case_id
        self.test_name = test_name
        self.stack_trace = stack_trace
        self.status_id = status_id
        self.start_time = start_time
        self.end_time = end_time
        self.message = message
        self.release_id = release_id
        self.test_set_id = test_set_id
        self.assert_count = assert_count
        self.build_id = build_id


    def post(self, spira_url, spira_username, spira_token):
        """
        Post the test run to Spira with the given credentials
        """
        url = spira_url + self.REST_SERVICE_URL + \
            (self.POST_TEST_RUN % self.project_id)
        # The credentials we need
        params = {
            'username': spira_username,
            'api-key': spira_token
        }

        # The headers we are sending to the server
        headers = {
            'accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': RUNNER_NAME
        }

        # The body we are sending
        body = {
            # Constant for plain text
            'TestRunFormatId': 1,
            'StartDate': self.start_time.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'EndDate': self.end_time.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'RunnerName': RUNNER_NAME,
            'RunnerTestName': self.test_name,
            'RunnerMessage': self.message,
            'RunnerStackTrace': self.stack_trace,
            'RunnerAssertCount': self.assert_count,
            'TestCaseId': self.test_case_id,
            # Passes (2) if the stack trace length is 0
            'ExecutionStatusId': self.status_id
        }

        # Releases and Test Sets are optional
        if(self.release_id != -1):
            body["ReleaseId"] = int(self.release_id)
            # If we have a release, also see if we have a build
            if self.build_id != -1:
                body["BuildId"] = int(self.build_id)

        if(self.test_set_id != -1):
            body["TestSetId"] = int(self.test_set_id)

        dumps = json.dumps(body)
        # print (dumps)

        response = requests.post(url, data=json.dumps(
            body), params=params, headers=headers)

        if response.status_code == 404:
            # Test Case Not Found
            print ("Unable to find a matching Spira test case of id TC:{}, so not able to post result".format(self.test_case_id))
            return -1
        elif response.status_code == 200:
            # OK
            testRun = response.json()
            testRunId = testRun['TestRunId']
            return testRunId
        else:
            # General Error
            print ("Unable to send results due to HTTP error: {} ({})".format(response.reason, response.status_code))
            return -1
        
class SpiraPostResults():
    def __init__(self, config_file):
        # Get the configuration information
        self.config = getConfig(config_file)

    def sendResults(self, test_results, testsuites):
        # Only do stuff if config is specified
        if self.config["url"] == "":
            print("Unable to report test results back to Spira since URL in configuration is empty")

        else:
            # See if we want to create a build
            build_id = -1
            if self.config["create_build"] == True:
                print("Creating new build in Spira at URL '{}'.".format(self.config["url"]))

                # See if we have any test failures, if so, mark build as failed
                buildStatusId = 2 # Passed
                for test_result in test_results:
                    if test_result["execution_status_id"] == 1:
                        buildStatusId = 1 # Failed    

                # Create the default build name, and description
                current_time = datetime.datetime.now(datetime.UTC)
                name = RUNNER_NAME + " Build " + current_time.isoformat()
                description = ""

                # See if the testsuites root node has any relevant metadata
                suites_name = testsuites.get('name')
                suites_tests = testsuites.get('tests')
                suites_failures = testsuites.get('failures')
                suites_errors = testsuites.get('errors')
                suites_skipped = testsuites.get('skipped')
                suites_assertions = testsuites.get('assertions')
                if suites_name is not None and suites_name != '':
                    name = suites_name + " Build " + current_time.isoformat()
                if suites_tests is not None and suites_tests != '':
                    description = description + '# Tests: {}\n'.format(suites_tests)
                if suites_failures is not None and suites_failures != '':
                    description = description + '# Failures: {}\n'.format(suites_failures)
                if suites_errors is not None and suites_errors != '':
                    description = description + '# Errors: {}\n'.format(suites_errors)
                if suites_skipped is not None and suites_skipped != '':
                    description = description + '# Skipped: {}\n'.format(suites_skipped)
                if suites_assertions is not None and suites_assertions != '':
                    description = description + '# Assertions: {}\n'.format(suites_assertions)

                # Create the build and get its id
                spiraBuild = SpiraBuild(self.config["project_id"], self.config["release_id"], buildStatusId, name, description)
                build_id = spiraBuild.post(self.config["url"], self.config["username"], self.config["token"])

            print("Sending test results to Spira at URL '{}'.".format(self.config["url"]))
            try:
                # Loop through all the tests
                success_count = 0
                for test_result in test_results:
                    # Get the current date/time
                    current_time = datetime.datetime.now(datetime.UTC)

                    # Send the result
                    is_error = self.sendResult(test_result, current_time, build_id)
                    if is_error == False:
                        success_count = success_count + 1

                # Report to the console
                print("Successfully reported {} test cases to Spira.\n".format(success_count))
        
            except Exception as exception:
                print("Unable to report test cases to Spira due to error '{}'.\n".format(exception))

    def sendResult(self, test_result, current_time, build_id):
        try:
            # See if we have a test specific test set id to use, otherwise use the global one
            test_set_id = -1
            if test_result["test_set_id"] > 0:
                test_set_id = test_result["test_set_id"]
            else:
                test_set_id = config["test_set_id"]

            # Create the Spira test run
            test_run = SpiraTestRun(
                config["project_id"], 
                test_result["test_case_id"], 
                test_result["name"], 
                test_result["stack_trace"], 
                test_result["execution_status_id"], 
                current_time - datetime.timedelta(seconds=test_result["duration_seconds"]), 
                current_time,
                message=test_result["message"], 
                release_id=config["release_id"], 
                test_set_id=test_set_id,
                assert_count=test_result["assert_count"],
                build_id=build_id
            )

            # Post the test run!
            testRunId = test_run.post(config["url"], config["username"], config["token"])
            is_error = (testRunId < 1)

            if is_error == False:
                # See if we have any file attachments to include
                if test_result["attachments"] is not None:
                    for attachment in test_result["attachments"]:
                        spiraDocument = SpiraDocument(config["project_id"], 1, testRunId, attachment['filename'], '1.0')
                        spiraDocument.post(config["url"], config["username"], config["token"], attachment['binary_data'])

                # See if we have any url attachments to include
                if test_result["links"] is not None:
                    for link in test_result["links"]:
                        spiraDocument = SpiraDocument(config["project_id"], 2, testRunId, link['url'], '1.0')
                        spiraDocument.post(config["url"], config["username"], config["token"])

            return is_error

        except Exception as exception:
            print("Unable to report test case '{}' to Spira due to error '{}'.\n".format(test_result["name"], exception))
            return True


class SpiraResultsParser():
    REGEX_ATTACHMENT_PATH = '\\[\\[ATTACHMENT\\|([a-zA-Z0-9_\\/\\\\\\.]+)\\]\\]'

    def __init__(self, config_file='spira.cfg'):
        # Create an array to store the results we want to send to Spira
        self.test_results = []
        self.config_file = config_file

    def readAttachmentFile(self,reportFile, filepath, attachments):
        # Open the image file
        try:
            report_folder = os.path.dirname(reportFile)
            filename = os.path.join(report_folder, filepath)
            image_file= open(filename, 'rb')
            image_data_binary = image_file.read()
            image_data = (base64.b64encode(image_data_binary)).decode('ascii')
            attachment = {
                'filename': filepath,
                'binary_data': image_data
            }
            attachments.append(attachment)
        except Exception as exception:
            print("Unable to read image file '{}' due to error '{}', so skipping attachment.\n".format(filename, exception))

    def parseResults(self, reportFile):
        # Get the config
        config = getConfig(config_file)

        # Open up the XML file
        # create element tree object 
        xmlDoc = ET.parse(reportFile) 

        # get root element 
        testsuites = xmlDoc.getroot()

        # iterate over the test suites 
        for testsuite in testsuites.findall('.//testsuite'):
            # get the test suite name
            suitename = testsuite.get('name')

            # iterate over the test cases in the test suite 
            for testcase in testsuite.findall('./testcase'):

                # extract the basic test information
                testname = testcase.get('name')
                classname = testcase.get('classname')
                elapsedtime = float(testcase.get('time'))

                # find the matching Spira test case id for this classname.name combination
                fullname = classname + '.' + testname
                test_case_id = -1
                if fullname.lower() in config["test_case_ids"]:
                    test_case_id = config["test_case_ids"][fullname.lower()]
                
                if test_case_id == -1:
                    print("Unable to find Spira id tag for test case '{}', so skipping this test case.".format(fullname))

                else:
                    # See if we have a matching test set ID, otherwise use the default one
                    test_set_id = -1
                    if suitename.lower() in config["test_set_ids"]:
                        test_set_id = config["test_set_ids"][suitename.lower()]


                    # Convert the test case status
                    execution_status_id = 2 # Passed

                    # Create the details and message, default to success
                    message = 'Success'
                    details = 'Nothing Reported\n'
                    assertCount = 0

                    # See if we have a failure node
                    failure = testcase.find('failure')
                    if failure is not None:
                        message = failure.get('message')
                        details = failure.text
                        execution_status_id = 1 # Fail
                        assertCount = 1

                    # See if we have a warning node
                    warning = testcase.find('warning')
                    if warning is not None:
                        message = warning.get('message')
                        details = warning.text
                        execution_status_id = 6 # Warning
                        assertCount = 1

                    # See if we have a error node
                    error = testcase.find('error')
                    if error is not None:
                        message = error.get('message')
                        details = error.text
                        execution_status_id = 5 # Blocked
                        assertCount = 1

                    # See if we have a skipped node
                    skipped = testcase.find('skipped')
                    if skipped is not None:
                        message = skipped.get('message')
                        details = skipped.text
                        execution_status_id = 4 # N/A
                        assertCount = 1

                    # See if we have assertions attribute
                    testcase_assertions = testcase.get('assertions')
                    if testcase_assertions is not None and testcase_assertions != '':
                        assertCount = int(testcase_assertions)

                    # See if we have any stdout or stderr to capture
                    attachments = []
                    systemOut = testcase.find('system-out')
                    if systemOut is not None:
                        details = details + 'System Out: ' + systemOut.text + '\n'

                        # See if we have any attachments
                        matches = re.finditer(self.REGEX_ATTACHMENT_PATH, systemOut.text)
                        for match in matches:
                            if match.lastindex == 1:
                                filepath = match.group(1)
                                # Open the image file
                                self.readAttachmentFile(reportFile, filepath, attachments)

                        
                    systemErr = testcase.find('system-err')
                    if systemErr is not None:
                        details = details + 'System Err: ' + systemErr.text + '\n'

                        # See if we have any attachments
                        matches = re.finditer(self.REGEX_ATTACHMENT_PATH, systemErr.text)
                        for match in matches:
                            if match.lastindex == 1:
                                filepath = match.group(1)
                                # Open the image file
                                self.readAttachmentFile(reportFile, filepath, attachments)

                    # See if we have any properties, also see if any are attachments or links
                    links = []
                    for property in testcase.findall('./properties/property'):
                        propName = property.get('name')
                        propValue = property.get('value')
                        if property.text is not None and property.text != '':
                            propValue = property.text
                        details = details + '- {}={}\n'.format(propName, propValue)

                        # See if an attachment
                        if propName.startswith('attachment'):
                            if propValue.startswith('http'):
                                link = {
                                    'url': propValue
                                }
                                links.append(link)
                            else:
                                # Open the image file
                                self.readAttachmentFile(reportFile, propValue, attachments)

                    # Create new test result object
                    test_result = {
                        'test_case_id': test_case_id,
                        'name': fullname,
                        'execution_status_id': execution_status_id,
                        'stack_trace': details,
                        'message': message,
                        'duration_seconds': elapsedtime,
                        'assert_count' : assertCount,
                        'test_set_id': test_set_id,
                        'attachments': attachments,
                        'links': links
                    }

                    # Parse the test case ID, and append the result
                    self.test_results.append(test_result)

        # Send the results to Spira
        spira_results = SpiraPostResults(config_file)
        spira_results.sendResults(self.test_results, testsuites)
                
if __name__ == '__main__':
    # Get the command arguments, if there are any
    try:
        report_file = sys.argv[1]
    except IndexError:
        report_file = "xunit.xml"
    try:
        config_file = sys.argv[2]
    except IndexError:
        config_file = "spira.cfg"

    # Parse the file and report the results
    spiraResults = SpiraResultsParser(config_file)
    spiraResults.parseResults(report_file)
