#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');

// Name of this extension
const RUNNER_NAME = 'xUnit (Node.js)';

/**
 * Configuration class for loading and storing Spira connection settings
 * and test case/test set mappings from the config file
 */
class SpiraConfig {
    constructor(configFile) {
        // Model of config object
        this.url = '';
        this.username = '';
        this.token = '';
        this.project_id = -1;
        this.release_id = -1;
        this.test_set_id = -1;
        this.create_build = false;
        this.test_case_ids = {};
        this.test_set_ids = {};
        
        this.loadConfig(configFile);
    }

    /**
     * Parse the config file and populate the configuration object
     */
    loadConfig(configFile) {
        const content = fs.readFileSync(configFile, 'utf-8');
        const lines = content.split('\n');
        let currentSection = '';

        for (let line of lines) {
            line = line.trim();
            // Skip empty lines and comments
            if (!line || line.startsWith('#')) continue;

            // Check for section headers
            if (line.startsWith('[') && line.endsWith(']')) {
                currentSection = line.slice(1, -1);
                continue;
            }

            const [key, ...valueParts] = line.split('=');
            if (!key || valueParts.length === 0) continue;

            const trimmedKey = key.trim();
            const value = valueParts.join('=').trim();

            // Handle credentials and test case / test set mappings differently
            if (currentSection === 'credentials') {
                if (trimmedKey === 'create_build') {
                    this.create_build = value.toLowerCase() === 'true';
                } else if (trimmedKey === 'project_id' || trimmedKey === 'release_id' || trimmedKey === 'test_set_id') {
                    this[trimmedKey] = parseInt(value);
                } else {
                    this[trimmedKey] = value;
                }
            } else if (currentSection === 'test_cases') {
                // Store test case mappings (classname.name -> test case ID)
                this.test_case_ids[trimmedKey.toLowerCase()] = parseInt(value);
            } else if (currentSection === 'test_sets') {
                // Store test set mappings (suite name -> test set ID)
                this.test_set_ids[trimmedKey.toLowerCase()] = parseInt(value);
            }
        }
    }
}

/**
 * A Document object model for Spira
 * Used to attach files or URLs to test runs
 */
class SpiraDocument {
    // The URL snippet used after the Spira URL
    static REST_SERVICE_URL = '/Services/v6_0/RestService.svc/';
    // The URL snippet used to post a new file or URL attachment linked to a test run
    static POST_DOCUMENT_FILE = 'projects/{}/documents/file';
    static POST_DOCUMENT_URL = 'projects/{}/documents/url';

    constructor(projectId, attachmentTypeId, testRunId, filenameOrUrl, versionName) {
        this.projectId = projectId;
        this.attachmentTypeId = attachmentTypeId; // 1 = File, 2 = URL
        this.testRunId = testRunId;
        this.filenameOrUrl = filenameOrUrl;
        this.versionName = versionName;
    }

    /**
     * Create a new attachment in Spira with the given credentials for associating the test runs with
     */
    async post(spiraUrl, username, token, binaryData = null) {
        // Default to URL attachment
        const endpoint = this.attachmentTypeId === 1 && binaryData
            ? `projects/${this.projectId}/documents/file`
            : `projects/${this.projectId}/documents/url`;

        const url = `${spiraUrl}${SpiraDocument.REST_SERVICE_URL}${endpoint}`;
        
        // The body we are sending
        const body = {
            ProjectId: this.projectId,
            AttachmentTypeId: this.attachmentTypeId,
            FilenameOrUrl: this.filenameOrUrl,
            CurrentVersion: this.versionName,
            AttachedArtifacts: [{
                ArtifactId: this.testRunId,
                ArtifactTypeId: 5 // Test Run
            }]
        };

        // Add the binary data if appropriate
        if (this.attachmentTypeId === 1 && binaryData) {
            body.BinaryData = binaryData;
        }

        try {
            const response = await axios.post(url, body, {
                params: { username, 'api-key': token },
                headers: {
                    'accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': RUNNER_NAME
                }
            });
            return response.data.AttachmentId;
        } catch (error) {
            if (error.response?.status === 404) {
                // Test Run Not Found
                console.log(`Unable to find a matching Spira test run of id TR:${this.testRunId}, so not able to post result`);
            } else {
                // General Error
                console.log(`Unable to create document due to HTTP error: ${error.message}`);
            }
            return null;
        }
    }
}

/**
 * A Build object model for Spira
 * Used to create build artifacts that group test runs together
 */
class SpiraBuild {
    // The URL snippet used after the Spira URL
    static REST_SERVICE_URL = '/Services/v6_0/RestService.svc/';
    // The URL snippet used to post a build. Needs the project ID and release ID to work
    static POST_BUILD = 'projects/{}/releases/{}/builds';

    constructor(projectId, releaseId, buildStatusId, name, description = '') {
        this.projectId = projectId;
        this.releaseId = releaseId;
        this.buildStatusId = buildStatusId; // 1=Failed, 2=Passed
        this.name = name;
        this.description = description;
    }

    /**
     * Create a new build in Spira with the given credentials for associating the test runs with
     */
    async post(spiraUrl, username, token) {
        const url = `${spiraUrl}${SpiraBuild.REST_SERVICE_URL}projects/${this.projectId}/releases/${this.releaseId}/builds`;

        // The body we are sending
        const body = {
            ProjectId: this.projectId,
            BuildStatusId: this.buildStatusId,
            ReleaseId: this.releaseId,
            Name: this.name,
            Description: this.description
        };

        try {
            const response = await axios.post(url, body, {
                params: { username, 'api-key': token },
                headers: {
                    'accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': RUNNER_NAME
                }
            });
            return response.data.BuildId;
        } catch (error) {
            if (error.response?.status === 404) {
                // Release Not Found
                console.log(`Unable to find a matching Spira release of id RL:${this.releaseId}, so not able to post result`);
            } else {
                // General Error
                console.log(`Unable to create build due to HTTP error: ${error.message}`);
            }
            return null;
        }
    }
}

/**
 * A TestRun object model for Spira
 * Represents a single test execution result
 */
class SpiraTestRun {
    // The URL snippet used after the Spira URL
    static REST_SERVICE_URL = '/Services/v6_0/RestService.svc/';
    // The URL snippet used to post an automated test run. Needs the project ID to work
    static POST_TEST_RUN = 'projects/%s/test-runs/record';

    constructor(projectId, testCaseId, testName, stackTrace, statusId, startTime, endTime, 
                message = '', releaseId = -1, testSetId = -1, assertCount = 0, buildId = -1) {
        this.projectId = projectId;
        this.testCaseId = testCaseId;
        this.testName = testName;
        this.stackTrace = stackTrace;
        this.statusId = statusId;
        this.startTime = startTime;
        this.endTime = endTime;
        this.message = message;
        this.releaseId = releaseId;
        this.testSetId = testSetId;
        this.assertCount = assertCount;
        this.buildId = buildId;
    }

    /**
     * Post the test run to Spira with the given credentials
     */
    async post(spiraUrl, username, token) {
        const url = `${spiraUrl}${SpiraTestRun.REST_SERVICE_URL}projects/${this.projectId}/test-runs/record`;

        // The body we are sending
        const body = {
            TestRunFormatId: 1, // Constant for plain text
            StartDate: this.startTime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            EndDate: this.endTime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            RunnerName: RUNNER_NAME,
            RunnerTestName: this.testName,
            RunnerMessage: this.message,
            RunnerStackTrace: this.stackTrace,
            RunnerAssertCount: this.assertCount,
            TestCaseId: this.testCaseId,
            ExecutionStatusId: this.statusId // Passes (2) if the stack trace length is 0
        };

        // Releases and Test Sets are optional
        if (this.releaseId !== -1) {
            body.ReleaseId = this.releaseId;
            // If we have a release, also see if we have a build
            if (this.buildId !== -1) {
                body.BuildId = this.buildId;
            }
        }

        if (this.testSetId !== -1) {
            body.TestSetId = this.testSetId;
        }

        try {
            const response = await axios.post(url, body, {
                params: { username, 'api-key': token },
                headers: {
                    'accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': RUNNER_NAME
                }
            });
            return response.data.TestRunId;
        } catch (error) {
            if (error.response?.status === 404) {
                // Test Case Not Found
                console.log(`Unable to find a matching Spira test case of id TC:${this.testCaseId}, so not able to post result`);
            } else {
                // General Error
                console.log(`Unable to send results due to HTTP error: ${error.message}`);
            }
            return -1;
        }
    }
}

/**
 * Main parser class for reading xUnit XML files and extracting test results
 */
class SpiraResultsParser {
    // Regex pattern for finding attachment paths in system output/error
    static REGEX_ATTACHMENT_PATH = /\[\[ATTACHMENT\|([a-zA-Z0-9_\/\\.]+)\]\]/g;

    constructor(configFile = 'spira.cfg') {
        // Create an array to store the results we want to send to Spira
        this.testResults = [];
        this.config = new SpiraConfig(configFile);
        this.attachmentRegex = SpiraResultsParser.REGEX_ATTACHMENT_PATH;
    }

    /**
     * Read an attachment file and convert it to base64 for uploading to Spira
     */
    readAttachmentFile(reportFile, filepath) {
        try {
            const reportFolder = path.dirname(reportFile);
            const fullPath = path.join(reportFolder, filepath);
            const fileData = fs.readFileSync(fullPath);
            const base64Data = fileData.toString('base64');
            return {
                filename: filepath,
                binary_data: base64Data
            };
        } catch (error) {
            console.log(`Unable to read image file '${filepath}' due to error '${error.message}', so skipping attachment.\n`);
            return null;
        }
    }

    /**
     * Parse the xUnit XML file and extract all test results
     */
    async parseResults(reportFile) {
        // Open up the XML file
        const xmlContent = fs.readFileSync(reportFile, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
        
        // Parse the XML into a JavaScript object
        const result = await parser.parseStringPromise(xmlContent);
        const testsuites = result.testsuites || result.testsuite;
        const testsuitesRoot = result.testsuites || {};

        // Process all test suites and test cases
        this.processTestSuites(testsuites, reportFile);

        // Send the results to Spira
        const spiraResults = new SpiraPostResults(this.config);
        await spiraResults.sendResults(this.testResults, testsuitesRoot);
    }

    /**
     * Recursively process test suites (which can be nested)
     */
    processTestSuites(node, reportFile, suiteName = '') {
        if (!node) return;

        // Handle both single and multiple test suites
        const suites = Array.isArray(node.testsuite) ? node.testsuite : (node.testsuite ? [node.testsuite] : [node]);

        // Iterate over the test suites
        for (const suite of suites) {
            // Get the test suite name
            const currentSuiteName = suite.name || suiteName;
            
            // Recursively process nested test suites
            if (suite.testsuite) {
                this.processTestSuites(suite, reportFile, currentSuiteName);
            }

            // Process test cases in this suite
            if (suite.testcase) {
                const testcases = Array.isArray(suite.testcase) ? suite.testcase : [suite.testcase];
                
                // Iterate over the test cases in the test suite
                for (const testcase of testcases) {
                    this.processTestCase(testcase, currentSuiteName, reportFile);
                }
            }
        }
    }

    /**
     * Process a single test case and extract all relevant information
     */
    processTestCase(testcase, suiteName, reportFile) {
        // Extract the basic test information
        const testName = testcase.name;
        const className = testcase.classname;
        const elapsedTime = parseFloat(testcase.time || 0);
        const fullName = `${className}.${testName}`;

        // Find the matching Spira test case id for this classname.name combination
        const testCaseId = this.config.test_case_ids[fullName.toLowerCase()];
        
        if (!testCaseId) {
            console.log(`Unable to find Spira id tag for test case '${fullName}', so skipping this test case.`);
            return;
        }

        // See if we have a matching test set ID, otherwise use the default one
        const testSetId = this.config.test_set_ids[suiteName.toLowerCase()] || -1;

        // Convert the test case status
        let executionStatusId = 2; // Passed
        let message = 'Success';
        let details = 'Nothing Reported\n';
        let assertCount = 0;

        // See if we have a failure node
        if (testcase.failure) {
            message = testcase.failure.message || 'Test Failed';
            details = testcase.failure._ || testcase.failure;
            executionStatusId = 1; // Fail
            assertCount = 1;
        } 
        // See if we have a warning node
        else if (testcase.warning) {
            message = testcase.warning.message || 'Test Warning';
            details = testcase.warning._ || testcase.warning;
            executionStatusId = 6; // Warning
            assertCount = 1;
        } 
        // See if we have an error node
        else if (testcase.error) {
            message = testcase.error.message || 'Test Error';
            details = testcase.error._ || testcase.error;
            executionStatusId = 5; // Blocked
            assertCount = 1;
        } 
        // See if we have a skipped node
        else if (testcase.skipped) {
            message = testcase.skipped.message || 'Test Skipped';
            details = testcase.skipped._ || testcase.skipped || '';
            executionStatusId = 4; // N/A
            assertCount = 1;
        }

        // See if we have assertions attribute
        if (testcase.assertions) {
            assertCount = parseInt(testcase.assertions);
        }

        // See if we have any stdout or stderr to capture
        const attachments = [];
        const links = [];

        // See if we have any stdout to capture
        if (testcase['system-out']) {
            const systemOut = testcase['system-out'];
            details += `System Out: ${systemOut}\n`;
            // See if we have any attachments
            this.extractAttachments(systemOut, reportFile, attachments);
        }

        // See if we have any stderr to capture
        if (testcase['system-err']) {
            const systemErr = testcase['system-err'];
            details += `System Err: ${systemErr}\n`;
            // See if we have any attachments
            this.extractAttachments(systemErr, reportFile, attachments);
        }

        // See if we have any properties, also see if any are attachments or links
        if (testcase.properties && testcase.properties.property) {
            const properties = Array.isArray(testcase.properties.property) 
                ? testcase.properties.property 
                : [testcase.properties.property];

            for (const prop of properties) {
                const propName = prop.name;
                const propValue = prop.value || prop._ || '';
                details += `- ${propName}=${propValue}\n`;

                // See if an attachment
                if (propName.startsWith('attachment')) {
                    if (propValue.startsWith('http')) {
                        links.push({ url: propValue });
                    } else {
                        // Open the image file
                        const attachment = this.readAttachmentFile(reportFile, propValue);
                        if (attachment) attachments.push(attachment);
                    }
                }
            }
        }

        // Create new test result object and append to results array
        this.testResults.push({
            test_case_id: testCaseId,
            name: fullName,
            execution_status_id: executionStatusId,
            stack_trace: details,
            message: message,
            duration_seconds: elapsedTime,
            assert_count: assertCount,
            test_set_id: testSetId,
            attachments: attachments,
            links: links
        });
    }

    /**
     * Extract attachment file paths from text using regex pattern
     */
    extractAttachments(text, reportFile, attachments) {
        const matches = text.matchAll(this.attachmentRegex);
        for (const match of matches) {
            const filepath = match[1];
            const attachment = this.readAttachmentFile(reportFile, filepath);
            if (attachment) attachments.push(attachment);
        }
    }
}

/**
 * Class responsible for posting test results to Spira
 */
class SpiraPostResults {
    constructor(config) {
        this.config = config;
    }

    /**
     * Send all test results to Spira, optionally creating a build first
     */
    async sendResults(testResults, testsuites) {
        // Only do stuff if config is specified
        if (!this.config.url) {
            console.log('Unable to report test results back to Spira since URL in configuration is empty');
            return;
        }

        // See if we want to create a build
        let buildId = -1;
        if (this.config.create_build) {
            console.log(`Creating new build in Spira at URL '${this.config.url}'.`);

            // See if we have any test failures, if so, mark build as failed
            let buildStatusId = 2; // Passed
            for (const testResult of testResults) {
                if (testResult.execution_status_id === 1) {
                    buildStatusId = 1; // Failed
                    break;
                }
            }

            // Create the default build name, and description
            const currentTime = new Date();
            let name = `${RUNNER_NAME} Build ${currentTime.toISOString()}`;
            let description = '';

            // See if the testsuites root node has any relevant metadata
            if (testsuites.name) name = `${testsuites.name} Build ${currentTime.toISOString()}`;
            if (testsuites.tests) description += `# Tests: ${testsuites.tests}\n`;
            if (testsuites.failures) description += `# Failures: ${testsuites.failures}\n`;
            if (testsuites.errors) description += `# Errors: ${testsuites.errors}\n`;
            if (testsuites.skipped) description += `# Skipped: ${testsuites.skipped}\n`;
            if (testsuites.assertions) description += `# Assertions: ${testsuites.assertions}\n`;

            // Create the build and get its id
            const spiraBuild = new SpiraBuild(
                this.config.project_id,
                this.config.release_id,
                buildStatusId,
                name,
                description
            );
            buildId = await spiraBuild.post(this.config.url, this.config.username, this.config.token);
        }

        console.log(`Sending test results to Spira at URL '${this.config.url}'.`);
        
        try {
            // Loop through all the tests
            let successCount = 0;
            for (const testResult of testResults) {
                // Get the current date/time
                const currentTime = new Date();
                
                // Send the result
                const isError = await this.sendResult(testResult, currentTime, buildId);
                if (!isError) successCount++;
            }

            // Report to the console
            console.log(`Successfully reported ${successCount} test cases to Spira.\n`);
        } catch (error) {
            console.log(`Unable to report test cases to Spira due to error '${error.message}'.\n`);
        }
    }

    /**
     * Send a single test result to Spira
     */
    async sendResult(testResult, currentTime, buildId) {
        try {
            // See if we have a test specific test set id to use, otherwise use the global one
            const testSetId = testResult.test_set_id > 0 
                ? testResult.test_set_id 
                : this.config.test_set_id;

            // Calculate start time based on duration
            const startTime = new Date(currentTime.getTime() - testResult.duration_seconds * 1000);
            
            // Create the Spira test run
            const testRun = new SpiraTestRun(
                this.config.project_id,
                testResult.test_case_id,
                testResult.name,
                testResult.stack_trace,
                testResult.execution_status_id,
                startTime,
                currentTime,
                testResult.message,
                this.config.release_id,
                testSetId,
                testResult.assert_count,
                buildId
            );

            // Post the test run!
            const testRunId = await testRun.post(this.config.url, this.config.username, this.config.token);
            const isError = testRunId < 1;

            if (!isError) {
                // See if we have any file attachments to include
                if (testResult.attachments) {
                    for (const attachment of testResult.attachments) {
                        const spiraDocument = new SpiraDocument(
                            this.config.project_id,
                            1, // File attachment
                            testRunId,
                            attachment.filename,
                            '1.0'
                        );
                        await spiraDocument.post(
                            this.config.url,
                            this.config.username,
                            this.config.token,
                            attachment.binary_data
                        );
                    }
                }

                // See if we have any url attachments to include
                if (testResult.links) {
                    for (const link of testResult.links) {
                        const spiraDocument = new SpiraDocument(
                            this.config.project_id,
                            2, // URL attachment
                            testRunId,
                            link.url,
                            '1.0'
                        );
                        await spiraDocument.post(this.config.url, this.config.username, this.config.token);
                    }
                }
            }

            return isError;
        } catch (error) {
            console.log(`Unable to report test case '${testResult.name}' to Spira due to error '${error.message}'.\n`);
            return true;
        }
    }
}

// Main execution
if (require.main === module) {
    // Get the command arguments, if there are any
    const args = process.argv.slice(2);
    const reportFile = args[0] || 'xunit.xml';
    const configFile = args[1] || 'spira.cfg';

    // Parse the file and report the results
    const parser = new SpiraResultsParser(configFile);
    parser.parseResults(reportFile).catch(error => {
        console.error('Error parsing results:', error.message);
        process.exit(1);
    });
}

// Export classes for use as a module
module.exports = { SpiraResultsParser, SpiraPostResults, SpiraTestRun, SpiraBuild, SpiraDocument, SpiraConfig };
